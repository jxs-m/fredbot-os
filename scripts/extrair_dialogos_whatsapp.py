#!/usr/bin/env python3
"""
extrair_dialogos_whatsapp.py
----------------------------
Script inspirado nas técnicas do vídeo de JustZando para coletar, limpar
e estruturar diálogos reais de chat para calibrar a persona do FredBot OS.

Funcionalidades:
1. Descompacta e lê todos os arquivos de chat dos zips em msg/*.zip.
2. Limpa mensagens de sistema, mídias ocultas, figurinhas e ruídos.
3. Agrupa mensagens consecutivas do mesmo interlocutor em turnos de diálogo.
4. Extrai pares reais (Amigo -> Fred) classificados por interlocutor.
5. Gera:
   - data/dialogos_extraidos.json (Base completa de diálogos minerados)
   - app/data/few_shots.ts (Exemplos Few-Shot curados por amigo prontos para o Gemini)
   - Sincronização opcional com o SQLite (data/fredbot.db) na tabela memoria_fatos.
"""

import os
import re
import sys
import json
import glob
import zipfile
import sqlite3
import argparse
from typing import List, Dict, Tuple, Optional

FRED_ALIASES = {'fred', 'fre', 'frederico', 'fred rieffel'}

SPEAKER_NORMALIZATION = {
    'daniel': 'Dani',
    'dani': 'Dani',
    'jotave': 'Jão (Jotave)',
    'joão vitor': 'Jão (Jotave)',
    'joao vitor': 'Jão (Jotave)',
    'louiz': 'Louizão',
    'louizão': 'Louizão',
    'luiz': 'Louizão',
    'dâma': 'Dâmares',
    'dama': 'Dâmares',
    'dâmares lopes': 'Dâmares',
    'damares lopes': 'Dâmares',
    'bz': 'Bz',
    'murilo loiro': 'Murilo',
    'murilo': 'Murilo',
    'maicon': 'Maicon',
    'miguel': 'Miguel',
    'você': 'Murilo', # Em exportações feitas pelo celular do Murilo
    'voce': 'Murilo',
}

MEDIA_FILTERS = [
    '<imagem ocultada>',
    '<figurinha omitida>',
    '<áudio oculto>',
    '<audio oculto>',
    '<vídeo omitido>',
    '<video omitido>',
    '<arquivo oculto>',
    '<arquivo de mídia oculto>',
    '<mensagem de album>',
    'mensagem apagada',
    'esta mensagem foi apagada',
    'as mensagens e as ligações são protegidas',
    'criou o grupo',
    'adicionou você',
    'mudou as configurações',
]

TIMESTAMP_PATTERNS = [
    re.compile(r'^\[(\d{1,2}/\d{1,2}/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\]\s+([^:]+?):\s*(.*)$'),
    re.compile(r'^(\d{1,2}/\d{1,2}/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\s+-\s+([^:]+?):\s*(.*)$'),
]

def clean_message_text(text: str) -> Optional[str]:
    lines = []
    for line in text.split('\n'):
        line_clean = line.strip()
        if not line_clean:
            continue
        lower = line_clean.lower()
        if any(ign in lower for ign in MEDIA_FILTERS):
            continue
        if lower.startswith('http://') or lower.startswith('https://'):
            continue
        lines.append(line_clean)
    
    joined = ' '.join(lines).strip()
    return joined if len(joined) > 1 else None

def normalize_speaker(raw_name: str) -> str:
    cleaned = raw_name.strip()
    lower = cleaned.lower()
    if lower in FRED_ALIASES:
        return 'Fred'
    return SPEAKER_NORMALIZATION.get(lower, cleaned)

def parse_zip_chat(zip_path: str) -> List[Dict[str, str]]:
    messages = []
    with zipfile.ZipFile(zip_path) as z:
        for filename in z.namelist():
            if not filename.endswith('.txt'):
                continue
            with z.open(filename) as f:
                content = f.read().decode('utf-8', errors='ignore')
                cur_msg = None

                for line in content.splitlines():
                    matched = False
                    for pattern in TIMESTAMP_PATTERNS:
                        m = pattern.match(line)
                        if m:
                            if cur_msg:
                                messages.append(cur_msg)
                            sender_raw = m.group(m.lastindex - 1)
                            text_raw = m.group(m.lastindex)
                            cur_msg = {
                                'source': os.path.basename(zip_path),
                                'sender': normalize_speaker(sender_raw),
                                'text': text_raw
                            }
                            matched = True
                            break
                    if not matched and cur_msg:
                        cur_msg['text'] += '\n' + line

                if cur_msg:
                    messages.append(cur_msg)
    return messages

def group_turns(messages: List[Dict[str, str]]) -> List[Dict[str, str]]:
    grouped = []
    for msg in messages:
        cleaned_text = clean_message_text(msg['text'])
        if not cleaned_text:
            continue

        if grouped and grouped[-1]['sender'] == msg['sender']:
            grouped[-1]['text'] += ' ' + cleaned_text
        else:
            grouped.append({
                'source': msg['source'],
                'sender': msg['sender'],
                'text': cleaned_text
            })
    return grouped

def extract_pairs(turns: List[Dict[str, str]]) -> List[Dict[str, str]]:
    pairs = []
    for i in range(len(turns) - 1):
        turn_amigo = turns[i]
        turn_fred = turns[i + 1]

        if turn_amigo['sender'] != 'Fred' and turn_fred['sender'] == 'Fred':
            # Filtros de relevância
            txt_amigo = turn_amigo['text'].strip()
            txt_fred = turn_fred['text'].strip()

            if 2 <= len(txt_amigo) <= 300 and 2 <= len(txt_fred) <= 400:
                pairs.append({
                    'source': turn_fred['source'],
                    'amigo': turn_amigo['sender'],
                    'pergunta': txt_amigo,
                    'resposta_fred': txt_fred
                })
    return pairs

def filter_curated_few_shots(pairs: List[Dict[str, str]]) -> Dict[str, List[Dict[str, str]]]:
    """
    Seleciona diálogos representativos, cheios de personalidade e gírias autênticas
    organizados por amigos e contextos.
    """
    by_friend: Dict[str, List[Dict[str, str]]] = {
        'Dani': [],
        'Jão (Jotave)': [],
        'Louizão': [],
        'Dâmares': [],
        'Murilo': [],
        'Bz': [],
        'Geral': [],
    }

    # Palavras e gírias características que dão autenticidade
    slang_keywords = [
        'booooo', 'krl', 'caralho', 'vô', 'vo', 'mano', 'irmão', 'fechou', 'tlgd',
        'morte', 'larpar', 'larpando', 'apaziguando', 'só vem', 'chinelo', 'guitarra',
        'baixo', 'ensaio', 'pizzaria', 'pedágio', 'caldeira', 'fortzinho', 'war',
        'casinha', 'dboas', 'tranquilo', 'óbvio', 'obv', 'mto', 'sem problemas'
    ]

    seen = set()

    for p in pairs:
        friend = p['amigo']
        key = (p['pergunta'], p['resposta_fred'])
        if key in seen:
            continue
        seen.add(key)

        score = 0
        p_lower = (p['pergunta'] + ' ' + p['resposta_fred']).lower()
        for kw in slang_keywords:
            if kw in p_lower:
                score += 2
        
        # Preferir respostas naturais e concisas do Fred
        if 3 <= len(p['resposta_fred']) <= 120:
            score += 1

        target_list = by_friend.get(friend, by_friend['Geral'])
        target_list.append((score, p))

    # Ordenar por score e pegar os melhores por amigo
    curated: Dict[str, List[Dict[str, str]]] = {}
    for friend, scored_list in by_friend.items():
        scored_list.sort(key=lambda x: x[0], reverse=True)
        # Limitar aos top 6 por amigo
        curated[friend] = [item[1] for item in scored_list[:6] if item[0] > 0]

    return curated

def generate_typescript_few_shots(curated: Dict[str, List[Dict[str, str]]], output_path: str):
    """
    Gera o arquivo app/data/few_shots.ts para injeção direta no Gemini.
    """
    lines = [
        "/**",
        " * few_shots.ts",
        " * Exemplos de diálogos autênticos reais extraídos do WhatsApp do Frederico",
        " * para calibração de tom e estilo da persona Fred IA (In-Context Few-Shot Learning).",
        " */",
        "",
        "export interface FewShotDialogo {",
        "  amigo: string;",
        "  mensagem: string;",
        "  respostaFred: string;",
        "}",
        "",
        "export const FEW_SHOT_DIALOGOS: Record<string, FewShotDialogo[]> = {"
    ]

    for friend, dialogs in curated.items():
        if not dialogs:
            continue
        lines.append(f"  '{friend}': [")
        for d in dialogs:
            msg_escaped = d['pergunta'].replace("'", "\\'").replace("\n", " ")
            resp_escaped = d['resposta_fred'].replace("'", "\\'").replace("\n", " ")
            lines.append("    {")
            lines.append(f"      amigo: '{d['amigo']}',")
            lines.append(f"      mensagem: '{msg_escaped}',")
            lines.append(f"      respostaFred: '{resp_escaped}',")
            lines.append("    },")
        lines.append("  ],")

    lines.append("};")
    lines.append("")
    lines.append("export function getFewShotPromptSnippet(): string {")
    lines.append("  let snippet = '\\n\\nEXEMPLOS REAIS DE RESPOSTA DO FRED NO WHATSAPP (FEW-SHOT):\\n';")
    lines.append("  for (const [amigo, exemplos] of Object.entries(FEW_SHOT_DIALOGOS)) {")
    lines.append("    snippet += `\\n[Conversas com ${amigo}]:\\n`;")
    lines.append("    for (const ex of exemplos.slice(0, 3)) {")
    lines.append("      snippet += `• ${ex.amigo}: \"${ex.mensagem}\"\\n  Fred: \"${ex.respostaFred}\"\\n`;")
    lines.append("    }")
    lines.append("  }")
    lines.append("  return snippet;")
    lines.append("}")
    lines.append("")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    print(f"✨ Arquivo TypeScript gerado em: {output_path}")

def sync_sqlite_memories(db_path: str):
    """
    Garante que fatos e histórias empíricas mineradas dos chats estejam
    persistidas na tabela memoria_fatos do banco SQLite.
    """
    if not os.path.exists(db_path):
        print(f"⚠️ Banco de dados não encontrado em {db_path}")
        return

    novas_memorias = [
        (
            'zoeira',
            'morte,fome,comida,resenha',
            'Quando a turma reclama de fome no grupo ou pós-ensaio, a resposta clássica e seca do Fred é: "morte, foi a primeira coisa q eu pensei"!'
        ),
        (
            'banda',
            'passagem de som,show,ensaio,maicon,dani',
            'Na organização dos shows e passagens de som da Orquídea Negra, o Fred é direto: quando perguntam se vai rolar passagem de som, ele confirma com um simples "vamo" e "eu to dboas de lista de convidados".'
        ),
        (
            'ensaio',
            'portão,campainha,chegando,só vem,indo',
            'A dinâmica de portão na casa do Fred: os guris avisam "já já tô aí" ou "tô no portão" e o Fred responde com "só vem" ou "indo", porque vive sem o controle do portão da frente!'
        ),
        (
            'rolê',
            'louizão,dormir,resenha,hibernar',
            'Quando o Louizão desiste de sair dizendo que a resenha hoje é só dormir, o Fred tira sarro na hora: "o cara vai hibernar!".'
        ),
        (
            'trote',
            'fantasia,trote,fósforo,dean winchester,dani,dâma,terceirão,colégio',
            'No trote do terceirão (reta final do Técnico em Informática Integrado ao Ensino Médio), a Dâma ia de Dean Winchester (e o Dani ficou bravo porque queria ir de Dean também). O Fred soltou que não fazia a mínima ideia e ia de "fósforo", e o Dani mandou ele botar fogo no cabelo!'
        )
    ]

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS memoria_fatos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            categoria TEXT NOT NULL,
            palavras_chave TEXT NOT NULL,
            conteudo TEXT NOT NULL
        )
    """)

    cursor.execute("SELECT conteudo FROM memoria_fatos")
    existing = {row[0] for row in cursor.fetchall()}

    inserted = 0
    for cat, kw, content in novas_memorias:
        if content not in existing:
            cursor.execute(
                "INSERT INTO memoria_fatos (categoria, palavras_chave, conteudo) VALUES (?, ?, ?)",
                (cat, kw, content)
            )
            inserted += 1

    conn.commit()
    conn.close()
    print(f"💾 Banco SQLite sincronizado ({db_path}): {inserted} novas memórias empíricas adicionadas.")

def main():
    parser = argparse.ArgumentParser(description="Extrai e processa diálogos do WhatsApp para o FredBot OS")
    parser.add_argument("--msg-dir", default="msg", help="Diretório onde estão os arquivos .zip")
    parser.add_argument("--output-json", default="data/dialogos_extraidos.json", help="Arquivo JSON de saída")
    parser.add_argument("--output-ts", default="app/data/few_shots.ts", help="Arquivo TypeScript Few-Shots")
    parser.add_argument("--db-path", default="data/fredbot.db", help="Caminho do SQLite")
    parser.add_argument("--sync-db", action="store_true", help="Sincronizar memórias no SQLite")
    args = parser.parse_args()

    zip_files = glob.glob(os.path.join(args.msg_dir, "*.zip"))
    if not zip_files:
        print(f"❌ Nenhum arquivo .zip encontrado em '{args.msg_dir}'!")
        sys.exit(1)

    print(f"🔍 Encontrados {len(zip_files)} arquivos .zip em '{args.msg_dir}'")
    all_messages = []
    for zpath in zip_files:
        print(f"  • Processando: {os.path.basename(zpath)}")
        msgs = parse_zip_chat(zpath)
        all_messages.extend(msgs)

    print(f"📥 Total de mensagens brutas lidas: {len(all_messages)}")
    turns = group_turns(all_messages)
    print(f"🔄 Total de turnos agrupados: {len(turns)}")

    pairs = extract_pairs(turns)
    print(f"💬 Total de pares de diálogo (Amigo -> Fred) extraídos: {len(pairs)}")

    # Salvar JSON completo
    os.makedirs(os.path.dirname(args.output_json), exist_ok=True)
    with open(args.output_json, 'w', encoding='utf-8') as f:
        json.dump(pairs, f, ensure_ascii=False, indent=2)
    print(f"📁 Base completa de diálogos salva em: {args.output_json}")

    # Filtrar Few-Shots
    curated = filter_curated_few_shots(pairs)
    total_curated = sum(len(v) for v in curated.values())
    print(f"⭐ Diálogos de alta fidelidade selecionados: {total_curated}")
    for friend, d_list in curated.items():
        print(f"   - {friend}: {len(d_list)} exemplos")

    # Gerar TypeScript
    generate_typescript_few_shots(curated, args.output_ts)

    # Sincronizar DB se solicitado ou por padrão
    if args.sync_db or os.path.exists(args.db_path):
        sync_sqlite_memories(args.db_path)

    print("\n✅ Processamento concluído com sucesso!")

if __name__ == "__main__":
    main()

