import { getDashboardData } from './db.server';
import { buscarMemoria } from './tools.server';
import type { ToolCallExecution } from '~/types';

export interface RuleMatchResult {
  reply: string;
  toolCalls: ToolCallExecution[];
}

function nowTimestamp(): string {
  return new Date().toLocaleTimeString('pt-BR');
}

function formatAgendaList(): string {
  const { agenda } = getDashboardData();
  if (agenda.length === 0) {
    return 'Minha agenda no SQLite tá zerada por enquanto! Quer marcar algum ensaio ou rolê?';
  }
  const lines = agenda.map((ev) => {
    const statusLabel = ev.status === 'confirmado' ? 'Confirmado' : 'Pendente';
    return `• ${ev.data} às ${ev.hora} — ${ev.titulo} (${ev.solicitante}) [${statusLabel}]`;
  });
  return `Ta na mão minha agenda direto do SQLite:\n${lines.join('\n')}`;
}

function formatRecadosList(): string {
  const { recados } = getDashboardData();
  if (recados.length === 0) {
    return 'Nenhum recado salvo na Central do Fred ainda!';
  }
  const lines = recados.slice(0, 6).map((r) => {
    const tag = r.prioridade === 'urgente' ? '[URGENTE]' : '[Normal]';
    const estado = r.lido ? '✓ lido' : 'novo';
    return `• ${tag} ${r.nomeAmigo}: "${r.mensagem}" (${estado})`;
  });
  return `Últimos recados salvos na Central do Fred:\n${lines.join('\n')}`;
}

function formatHelpText(): string {
  return [
    'Eai! Aqui é o Fred IA (Modo Híbrido: Regras Tradicionais + Google Gemini).',
    '',
    'Comandos rápidos por regra local (funcionam até offline):',
    '• /agenda — Lista os compromissos salvos no SQLite',
    '• /recados — Mostra os recados recentes da Central do Fred',
    '• /status — Exibe o status do sistema e contadores do banco',
    '• /ajuda — Mostra esta lista de comandos',
    '',
    'Ou pode conversar normalmente que eu uso a IA pra marcar rolê, anotar recado urgente ou lembrar histórias da Orquídea Negra!',
  ].join('\n');
}

/**
 * Regras tradicionais determinísticas executadas antes da chamada à IA.
 * Permite comandos instantâneos sem gastar tokens e mantém o sistema híbrido (Regras + IA).
 */
export function tryTraditionalCommand(rawMessage: string): RuleMatchResult | null {
  const normalized = rawMessage.trim().toLowerCase();
  const ts = nowTimestamp();

  if (normalized === '/ajuda' || normalized === '/help' || normalized === '/comandos') {
    return {
      reply: formatHelpText(),
      toolCalls: [
        {
          name: 'regraLocal:ajuda',
          args: { comando: normalized },
          result: { mode: 'traditional_rule', handled: true },
          timestamp: ts,
        },
      ],
    };
  }

  if (normalized === '/agenda') {
    const reply = formatAgendaList();
    return {
      reply,
      toolCalls: [
        {
          name: 'regraLocal:agenda',
          args: { comando: '/agenda' },
          result: { mode: 'traditional_rule', totalEventos: getDashboardData().agenda.length },
          timestamp: ts,
        },
      ],
    };
  }

  if (normalized === '/recados') {
    const reply = formatRecadosList();
    return {
      reply,
      toolCalls: [
        {
          name: 'regraLocal:recados',
          args: { comando: '/recados' },
          result: { mode: 'traditional_rule', totalRecados: getDashboardData().recados.length },
          timestamp: ts,
        },
      ],
    };
  }

  if (normalized === '/status') {
    const data = getDashboardData();
    return {
      reply: `FredOS operando normalmente! SQLite conectado: ${data.agenda.length} evento(s) na agenda, ${data.recados.length} recado(s) e ${data.totalMemorias} memória(s) cadastradas.`,
      toolCalls: [
        {
          name: 'regraLocal:status',
          args: { comando: '/status' },
          result: {
            mode: 'traditional_rule',
            agenda: data.agenda.length,
            recados: data.recados.length,
            memorias: data.totalMemorias,
          },
          timestamp: ts,
        },
      ],
    };
  }

  return null;
}

/**
 * Fallback tradicional baseado em regras/palavras-chave caso a API de IA esteja
 * indisponível, sem chave ou com erro de rede/cota.
 */
export function runTraditionalFallback(rawMessage: string, reason: string): RuleMatchResult {
  const lower = rawMessage.trim().toLowerCase();
  const ts = nowTimestamp();

  if (/^(oi|olá|ola|eai|e aí|opa|fala|salve|bom dia|boa tarde|boa noite)\b/.test(lower)) {
    return {
      reply: `Eai mano, tudo tranquilo?? Tô no modo de regras locais agora (${reason}), mas sigo por aqui! Manda /agenda, /recados ou /ajuda se precisar ver algo do SQLite.`,
      toolCalls: [
        {
          name: 'fallbackRegra:saudacao',
          args: { reason },
          result: { mode: 'traditional_fallback', matched: 'greeting' },
          timestamp: ts,
        },
      ],
    };
  }

  if (/(agenda|compromisso|horário|horario|ensaio|marcado|livre)/.test(lower)) {
    return {
      reply: `⚠️ IA offline (${reason}), mas puxei direto pelas regras do SQLite:\n\n${formatAgendaList()}`,
      toolCalls: [
        {
          name: 'fallbackRegra:agenda',
          args: { reason },
          result: { mode: 'traditional_fallback', matched: 'agenda' },
          timestamp: ts,
        },
      ],
    };
  }

  if (/(recado|recados|aviso|mensagem)/.test(lower)) {
    return {
      reply: `⚠️ IA offline (${reason}), mas puxei direto pelas regras do SQLite:\n\n${formatRecadosList()}`,
      toolCalls: [
        {
          name: 'fallbackRegra:recados',
          args: { reason },
          result: { mode: 'traditional_fallback', matched: 'recados' },
          timestamp: ts,
        },
      ],
    };
  }

  if (/(orquídea|orquidea|banda|xis|lanche|halloween|rpg|guitarra|baixo|pedágio|pedagio|larpar)/.test(lower)) {
    const mem = buscarMemoria(lower);
    const resumo =
      mem.data.memorias.length > 0
        ? mem.data.memorias.map((m) => `• [${m.categoria}] ${m.conteudo}`).join('\n')
        : 'Não achei nada exato sobre isso no SQLite.';
    return {
      reply: `⚠️ IA offline (${reason}), mas achei isso no banco de memórias do SQLite:\n\n${resumo}`,
      toolCalls: [
        {
          name: 'fallbackRegra:buscarMemoria',
          args: { termo: lower, reason },
          result: mem as unknown as Record<string, unknown>,
          timestamp: ts,
        },
      ],
    };
  }

  return {
    reply: `⚠️ Deu um tilt na conexão com a IA (${reason}), então ativei o modo de regras locais! Enquanto a API não volta, você pode digitar /agenda, /recados, /status ou /ajuda.`,
    toolCalls: [
      {
        name: 'fallbackRegra:padrao',
        args: { reason },
        result: { mode: 'traditional_fallback', matched: 'default' },
        timestamp: ts,
      },
    ],
  };
}

