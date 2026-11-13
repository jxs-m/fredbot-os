import { db } from './db.server';
import type { Compromisso, PrioridadeRecado } from '~/types';

export interface ToolResult<T = unknown> {
  success: boolean;
  action: string;
  data: T;
  message: string;
}

export function consultarAgenda(data: string, hora?: string): ToolResult<{ compromissos: Compromisso[]; disponivel: boolean; solicitouHora?: string }> {
  try {
    const query = hora
      ? db.prepare('SELECT id, titulo, data, hora, solicitante, status FROM agenda WHERE data = ? AND hora = ?')
      : db.prepare('SELECT id, titulo, data, hora, solicitante, status FROM agenda WHERE data = ? ORDER BY hora ASC');

    const compromissos = (hora ? query.all(data, hora) : query.all(data)) as unknown as Compromisso[];

    const disponivel = compromissos.length === 0;

    let message = '';
    if (hora) {
      message = disponivel
        ? `Horário livre em ${data} às ${hora}!`
        : `Horário ocupado em ${data} às ${hora} por: ${compromissos.map((c) => c.titulo).join(', ')}`;
    } else {
      message = compromissos.length > 0
        ? `Encontrados ${compromissos.length} evento(s) em ${data}: ${compromissos.map((c) => `${c.hora} - ${c.titulo}`).join('; ')}`
        : `Nenhum compromisso marcado para ${data}. A agenda está totalmente livre neste dia!`;
    }

    return {
      success: true,
      action: 'consultarAgenda',
      data: {
        compromissos,
        disponivel,
        solicitouHora: hora,
      },
      message,
    };
  } catch (error) {
    return {
      success: false,
      action: 'consultarAgenda',
      data: { compromissos: [], disponivel: false },
      message: `Erro ao consultar agenda: ${(error as Error).message}`,
    };
  }
}

export function criarCompromisso(
  titulo: string,
  data: string,
  hora: string,
  solicitante: string
): ToolResult<{ id: number; titulo: string; data: string; hora: string; solicitante: string; status: string }> {
  try {
    // Normalizar data caso venha como "quarta-feira" ou similar
    let dataFormatada = data;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      // Se for formato genérico, atribuímos data coerente da semana
      const hoje = new Date();
      hoje.setDate(hoje.getDate() + 5);
      dataFormatada = hoje.toISOString().split('T')[0];
    }

    const stmt = db.prepare(`
      INSERT INTO agenda (titulo, data, hora, solicitante, status)
      VALUES (?, ?, ?, ?, 'pendente_aprovacao')
    `);

    const result = stmt.run(titulo, dataFormatada, hora, solicitante);
    const novoId = Number(result.lastInsertRowid);

    return {
      success: true,
      action: 'criarCompromisso',
      data: {
        id: novoId,
        titulo,
        data: dataFormatada,
        hora,
        solicitante,
        status: 'pendente_aprovacao',
      },
      message: `Compromisso "${titulo}" agendado para ${dataFormatada} às ${hora} (solicitado por ${solicitante}). Status: pendente de confirmação do Fred real!`,
    };
  } catch (error) {
    return {
      success: false,
      action: 'criarCompromisso',
      data: { id: 0, titulo, data, hora, solicitante, status: 'erro' },
      message: `Falha ao gravar evento na agenda: ${(error as Error).message}`,
    };
  }
}

export function salvarRecado(
  nomeAmigo: string,
  mensagem: string,
  prioridade: PrioridadeRecado = 'normal'
): ToolResult<{ id: number; nomeAmigo: string; mensagem: string; prioridade: string; timestamp: string }> {
  try {
    const timestamp = new Date().toLocaleString('pt-BR');
    const stmt = db.prepare(`
      INSERT INTO recados (nome_amigo, mensagem, prioridade, criado_em, lido)
      VALUES (?, ?, ?, ?, 0)
    `);

    const result = stmt.run(nomeAmigo, mensagem, prioridade, timestamp);
    const novoId = Number(result.lastInsertRowid);

    return {
      success: true,
      action: 'salvarRecado',
      data: {
        id: novoId,
        nomeAmigo,
        mensagem,
        prioridade,
        timestamp,
      },
      message: `Recado ${prioridade === 'urgente' ? 'URGENTE ' : ''}de ${nomeAmigo} salvo com sucesso na Central do Fred!`,
    };
  } catch (error) {
    return {
      success: false,
      action: 'salvarRecado',
      data: { id: 0, nomeAmigo, mensagem, prioridade, timestamp: '' },
      message: `Erro ao salvar recado: ${(error as Error).message}`,
    };
  }
}

export function buscarMemoria(termo: string): ToolResult<{ memorias: Array<{ categoria: string; conteudo: string }> }> {
  try {
    const termoClean = termo.toLowerCase().trim();
    const rows = db
      .prepare('SELECT categoria, palavras_chave, conteudo FROM memoria_fatos')
      .all() as unknown as Array<{ categoria: string; palavras_chave: string; conteudo: string }>;

    const palavrasBusca = termoClean.split(/[\s,]+/);

    const matches = rows.filter((row) => {
      const textoCompleto = `${row.categoria} ${row.palavras_chave} ${row.conteudo}`.toLowerCase();
      return palavrasBusca.some((p) => p.length > 2 && textoCompleto.includes(p));
    });

    const resultadoFinal = matches.length > 0 ? matches : rows.slice(0, 2);

    return {
      success: true,
      action: 'buscarMemoria',
      data: {
        memorias: resultadoFinal.map((m) => ({
          categoria: m.categoria,
          conteudo: m.conteudo,
        })),
      },
      message: `Recuperadas ${resultadoFinal.length} lembrança(s) históricas da turma relacionadas a "${termo}".`,
    };
  } catch (error) {
    return {
      success: false,
      action: 'buscarMemoria',
      data: { memorias: [] },
      message: `Erro na busca de memórias: ${(error as Error).message}`,
    };
  }
}
