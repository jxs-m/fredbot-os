import { GoogleGenerativeAI, SchemaType, type Part } from '@google/generative-ai';
import { FRED_PERSONA } from '~/data/persona';
import { getFewShotPromptSnippet } from '~/data/few_shots';
import { consultarAgenda, criarCompromisso, salvarRecado, buscarMemoria } from './tools.server';
import { tryTraditionalCommand, runTraditionalFallback } from './rules.server';
import type { PrioridadeRecado, ToolCallExecution } from '~/types';

export interface ProcessedResponse {
  reply: string;
  toolCalls: ToolCallExecution[];
}

const GEMINI_TIMEOUT_MS = 25_000;

function getApiKey(): string {
  return process.env.GEMINI_API_KEY?.trim() || '';
}

const toolDeclarations = [
  {
    name: 'consultarAgenda',
    description: 'Consulta os compromissos agendados no SQLite para uma data específica ou verifica se determinado horário está livre.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        data: {
          type: SchemaType.STRING,
          description: 'Data no formato YYYY-MM-DD para verificar a agenda.',
        },
        hora: {
          type: SchemaType.STRING,
          description: 'Horário específico no formato HH:MM (opcional).',
        },
      },
      required: ['data'],
    },
  },
  {
    name: 'criarCompromisso',
    description: 'Grava um novo compromisso na agenda do Frederico no banco de dados SQLite com status pendente de confirmação.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        titulo: {
          type: SchemaType.STRING,
          description: 'Título do compromisso (ex: Futebol Society, Estudo de IA, Jogatina).',
        },
        data: {
          type: SchemaType.STRING,
          description: 'Data do evento no formato YYYY-MM-DD.',
        },
        hora: {
          type: SchemaType.STRING,
          description: 'Horário de início no formato HH:MM.',
        },
        solicitante: {
          type: SchemaType.STRING,
          description: 'Nome do amigo ou grupo que está marcando o evento.',
        },
      },
      required: ['titulo', 'data', 'hora', 'solicitante'],
    },
  },
  {
    name: 'salvarRecado',
    description: 'Registra um recado na tabela de recados do SQLite para o Frederico ler na central do sistema.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        nomeAmigo: {
          type: SchemaType.STRING,
          description: 'Nome do amigo que está deixando o recado.',
        },
        mensagem: {
          type: SchemaType.STRING,
          description: 'Conteúdo detalhado do recado ou aviso.',
        },
        prioridade: {
          type: SchemaType.STRING,
          description: 'Prioridade do recado: "normal" ou "urgente".',
        },
      },
      required: ['nomeAmigo', 'mensagem'],
    },
  },
  {
    name: 'buscarMemoria',
    description: 'Busca histórias passadas, piadas internas, lanches e rolês antigos da turma na base de memórias (RAG).',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        termo: {
          type: SchemaType.STRING,
          description: 'Palavra-chave ou assunto da lembrança (ex: lanche monstro, futebol, prova de IA, xis).',
        },
      },
      required: ['termo'],
    },
  },
];

type ToolArgs = Record<string, unknown>;

const TOOL_HANDLERS: Record<string, (args: ToolArgs) => Record<string, unknown>> = {
  consultarAgenda: (args) =>
    consultarAgenda(String(args.data ?? ''), args.hora ? String(args.hora) : undefined) as unknown as Record<string, unknown>,
  criarCompromisso: (args) =>
    criarCompromisso(
      String(args.titulo ?? ''),
      String(args.data ?? ''),
      String(args.hora ?? ''),
      String(args.solicitante ?? '')
    ) as unknown as Record<string, unknown>,
  salvarRecado: (args) =>
    salvarRecado(
      String(args.nomeAmigo ?? ''),
      String(args.mensagem ?? ''),
      (args.prioridade === 'urgente' ? 'urgente' : 'normal') as PrioridadeRecado
    ) as unknown as Record<string, unknown>,
  buscarMemoria: (args) =>
    buscarMemoria(String(args.termo ?? '')) as unknown as Record<string, unknown>,
};

/**
 * O SDK do Google Gemini exige que o histórico de chat comece obrigatoriamente com role: 'user',
 * alterne os papéis e termine em 'model' antes de sendMessage(userMessage).
 */
function sanitizeChatHistory(
  chatHistory: Array<{ role: 'user' | 'model'; parts: string }>
): Array<{ role: 'user' | 'model'; parts: [{ text: string }] }> {
  const sanitized: Array<{ role: 'user' | 'model'; parts: [{ text: string }] }> = [];
  let foundFirstUser = false;

  for (const item of chatHistory) {
    const text = (item.parts || '').trim();
    if (!text) continue;

    if (!foundFirstUser) {
      if (item.role === 'user') {
        foundFirstUser = true;
        sanitized.push({ role: 'user', parts: [{ text }] });
      }
      continue;
    }

    const last = sanitized[sanitized.length - 1];
    if (last && last.role === item.role) {
      last.parts[0].text += `\n${text}`;
    } else {
      sanitized.push({ role: item.role, parts: [{ text }] });
    }
  }

  while (sanitized.length > 0 && sanitized[sanitized.length - 1].role === 'user') {
    sanitized.pop();
  }

  return sanitized;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('TIMEOUT_EXCEEDED'));
    }, timeoutMs);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function classifyGeminiError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const lower = raw.toLowerCase();

  if (lower.includes('timeout_exceeded')) {
    return 'tempo limite excedido na resposta da IA';
  }
  if (lower.includes('429') || lower.includes('quota') || lower.includes('resource_exhausted')) {
    return 'limite de requisições/cota do Gemini atingido';
  }
  if (lower.includes('401') || lower.includes('403') || lower.includes('api_key_invalid') || lower.includes('api key')) {
    return 'chave GEMINI_API_KEY inválida ou sem permissão';
  }
  if (lower.includes('fetch failed') || lower.includes('enotfound') || lower.includes('network') || lower.includes('econn')) {
    return 'falha de conexão com a internet/API';
  }
  return 'erro temporário na API do Gemini';
}

export async function askFredBot(
  userMessage: string,
  chatHistory: Array<{ role: 'user' | 'model'; parts: string }> = []
): Promise<ProcessedResponse> {
  // 1. Camada de Regras Tradicionais: comandos diretos determinísticos antes da IA
  const traditionalMatch = tryTraditionalCommand(userMessage);
  if (traditionalMatch) {
    return traditionalMatch;
  }

  // 2. Fallback por Regras caso não haja chave da API configurada
  const apiKey = getApiKey();
  if (!apiKey || apiKey === 'COLOQUE_SUA_CHAVE_AQUI') {
    return runTraditionalFallback(userMessage, 'GEMINI_API_KEY ausente no .env');
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: `${FRED_PERSONA.systemPrompt}\n${getFewShotPromptSnippet()}`,
      tools: [{ functionDeclarations: toolDeclarations as any }],
      generationConfig: {
        temperature: 0.75,
        topP: 0.95,
      },
    });

    const chat = model.startChat({
      history: sanitizeChatHistory(chatHistory),
    });

    const toolCallsExecuted: ToolCallExecution[] = [];
    let response = await withTimeout(chat.sendMessage(userMessage), GEMINI_TIMEOUT_MS);
    let functionCalls = response.response.functionCalls();

    let loopSafety = 0;
    while (functionCalls && functionCalls.length > 0 && loopSafety < 4) {
      loopSafety++;
      const functionResponses: Part[] = [];

      for (const call of functionCalls) {
        const { name, args } = call;
        const toolArgs = (args || {}) as ToolArgs;
        const handler = TOOL_HANDLERS[name];
        const toolResult = handler
          ? handler(toolArgs)
          : { success: false, message: `Ferramenta desconhecida: ${name}` };

        toolCallsExecuted.push({
          name,
          args: toolArgs,
          result: toolResult,
          timestamp: new Date().toLocaleTimeString('pt-BR'),
        });

        functionResponses.push({
          functionResponse: {
            name,
            response: toolResult,
          },
        });
      }

      response = await withTimeout(chat.sendMessage(functionResponses), GEMINI_TIMEOUT_MS);
      functionCalls = response.response.functionCalls();
    }

    const replyText = response.response.text();

    return {
      reply: replyText || 'Bah, deu algum tilt aqui na minha conexão, mas já tô de volta!',
      toolCalls: toolCallsExecuted,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Erro desconhecido';
    console.error('[FredBot] Erro na API do Google Gemini:', errorMsg);
    const friendlyReason = classifyGeminiError(error);
    return runTraditionalFallback(userMessage, friendlyReason);
  }
}
