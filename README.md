# FredBot OS — PersonaBot Tech / FredIA

> **Instituição:** Instituto Federal Farroupilha (IFFarroupilha)  
> **Curso:** Técnico em Informática Integrado ao Ensino Médio (Concluintes)  
> **Disciplina:** Tópicos Emergentes da Informática  
> **Professor:** Luiz Rafael Jacques Caldeira  
> **Equipe:** Murilo Jaques, Daniel Guerra, João Vitor  
> **Aplicação Prática:** Agente Conversacional Híbrido (Regras Tradicionais + IA Generativa) com Function Calling e SQLite

---

## 1. Sobre o Projeto

O **FredBot OS** é um agente conversacional autônomo desenvolvido como o *Gêmeo Digital* do colega **Frederico**, pela empresa simulada **PersonaBot Tech**. Como o Fred real está na reta final de conclusão do curso **Técnico em Informática Integrado ao Ensino Médio** no IFFarroupilha — sobrecarregado entre entregas da disciplina de Tópicos Emergentes da Informática (IA), rotina escolar e ensaios da banda *Orquídea Negra* —, o **Fred IA** assume a comunicação com a turma e executa ações reais no sistema.

### Como o projeto atende aos requisitos do Trabalho Final
1. **Interface Funcional:** Desktop web interativo (*FredOS*) com 3 janelas simultâneas: Chat em tempo real, Central do Fred (agenda e recados editáveis) e *Live Inspector* de chamadas.
2. **Integração com IA:** Conexão com a API do **Google Gemini** (`gemini-2.5-flash` via `@google/generative-ai`), calibrada por `systemInstruction` e *Few-Shot Learning* extraído de conversas reais do WhatsApp.
3. **Funcionalidades Adicionais (além do chat):**
   - **Agenda Inteligente:** Consulta horários livres (`consultarAgenda`), registra novos compromissos como pendentes (`criarCompromisso`) e permite confirmação manual na Central do Fred.
   - **Central de Recados:** Salva avisos com prioridade `normal` ou `urgente` (`salvarRecado`) e permite marcar recados como lidos no painel.
   - **Memória Histórica (RAG em SQLite):** Recupera histórias reais da turma e da banda (`buscarMemoria`) diretamente do banco relacional.
   - **Pipeline de Ingestão de WhatsApp:** Script Python que minera arquivos `.zip` exportados do WhatsApp e gera exemplos *Few-Shot* e memórias empíricas.
4. **Combinação de Regras Tradicionais + IA (Modelo Híbrido):**
   - O sistema **não abandona regras determinísticas**: comandos rápidos como `/ajuda`, `/agenda`, `/recados` e `/status` são interceptados localmente antes de acionar a IA (zero custo de tokens e resposta instantânea).
   - Caso a API do Gemini esteja indisponível, sem chave ou com cota excedida, entra em ação um **fallback por regras tradicionais** que ainda responde saudações e consulta agenda, recados e memórias direto no SQLite.
5. **Tratamento de Erros e Controle de Requisições:**
   - **Rate Limiting:** Limitador por janela deslizante em memória (`app/services/rateLimit.server.ts`, máx. 15 requisições por minuto por cliente) retornando HTTP `429`.
   - **Validação e Timeouts:** Validação de entrada vazia/tamanho máximo (`1000` caracteres), timeout de `25s` na chamada do Gemini e tradução amigável de erros de rede, chave (`401/403`) e cota (`429`).
   - **ErrorBoundary:** Recuperação visual no frontend caso ocorra qualquer erro inesperado de rota.

---

## 2. Organização do Código (Arquitetura Fullstack)

O projeto utiliza **Remix v2 + Vite** em **100% TypeScript**, unificando o frontend React e o backend Node.js no mesmo repositório com separação estrita por arquivos `.server.ts` (equivalente a um `index.html/main.js` consumindo uma rota `POST` no backend Express):

```text
empresa/
├── app/
│   ├── data/
│   │   ├── persona.ts          # Identidade, contexto e regras de comportamento do Fred
│   │   ├── few_shots.ts        # Exemplos reais de diálogo extraídos do WhatsApp
│   │   └── seeds.ts            # Memórias históricas do Fred e da turma
│   ├── routes/
│   │   └── _index.tsx          # Interface FredOS + loader/action HTTP POST + ErrorBoundary
│   ├── services/
│   │   ├── db.server.ts        # Conexão SQLite (node:sqlite) e ações do painel
│   │   ├── gemini.server.ts    # Integração Gemini API + Function Calling + fallback
│   │   ├── rules.server.ts     # Motor de regras tradicionais (/ajuda, /agenda, fallback)
│   │   ├── rateLimit.server.ts # Controle de taxa de requisições (janela deslizante)
│   │   └── tools.server.ts     # Implementação das 4 ferramentas SQLite
│   ├── styles/                 # Estilos do FredOS Desktop
│   ├── types/                  # Tipagens TypeScript compartilhadas
│   └── root.tsx                # Shell HTML raiz e ErrorBoundary global
├── scripts/
│   └── extrair_dialogos_whatsapp.py  # Extrator de chats .zip do WhatsApp
├── data/                       # Banco local SQLite (fredbot.db - ignorado no Git)
├── .env.example                # Modelo de configuração de variáveis de ambiente
└── .gitignore                  # Protege .env, node_modules, bancos locais e chats privados
```

---

## 3. Como Executar

### Pré-requisitos
- **Node.js >= 20** (recomendado **Node.js 24** pelo módulo nativo `node:sqlite`)
- **NPM >= 10**
- *(Opcional)* **Python 3** caso deseje reprocessar arquivos `.zip` do WhatsApp

### Passo a Passo
```bash
# 1. Instalar dependências
npm install

# 2. Copiar o modelo de variáveis de ambiente e inserir sua chave do Google AI Studio
cp .env.example .env
# Edite o arquivo .env e preencha: GEMINI_API_KEY="sua_chave_aqui"

# 3. Iniciar o servidor de desenvolvimento
npm run dev
# ou
./run.sh
```

Acesse no navegador: **`http://localhost:3000`**

### Scripts Disponíveis
- `npm run dev`: Sobe a aplicação em modo desenvolvimento na porta `3000`.
- `npm run build`: Gera o build de produção cliente e servidor.
- `npm run typecheck`: Executa a checagem de tipos TypeScript (`tsc`).
- `npm run extract:chats`: Processa arquivos `.zip` da pasta `msg/` e regenera `app/data/few_shots.ts` + memórias no SQLite.

---

## 4. Roteiro de Testes e Demonstração

Para validar o comportamento híbrido (Regras + IA) e as funcionalidades adicionais, envie no chat:

1. **⚡ Regra Tradicional Direta (sem gastar API):**
   - *Comando:* `/agenda` ou `/ajuda`
   - *Ação:* O motor `rules.server.ts` responde instantaneamente e registra `regraLocal:agenda` no Live Inspector.
2. **⚽ Agendamento via IA (Function Calling + SQLite):**
   - *Comando:* `"E aí Dani, tudo tranquilo? Bora marcar um futebol na quarta-feira às 19h?"`
   - *Ação:* Invoca `consultarAgenda` $\rightarrow$ verifica disponibilidade $\rightarrow$ invoca `criarCompromisso` e cria o card na Central do Fred para confirmação.
3. **📟 Recado Urgente (Persistência + Toggle na UI):**
   - *Comando:* `"Fred, anota um recado urgente: avisa quando puder me devolver a calculadora científica."`
   - *Ação:* Invoca `salvarRecado` com prioridade urgente e exibe na Central do Fred com botão para marcar como lido.
4. **🎸 Memória Histórica (RAG no SQLite):**
   - *Comando:* `"Fred, conta aí por que o nome da banda é Orquídea Negra se a logo é roxa?"`
   - *Ação:* Invoca `buscarMemoria` e responde no estilo autêntico do Fred usando os *Few-Shots* do WhatsApp.
