export type PrioridadeRecado = 'normal' | 'urgente';
export type StatusCompromisso = 'confirmado' | 'pendente_aprovacao' | 'conflito';
export type CategoriaMemoria = 'rolê' | 'comida' | 'faculdade' | 'viagem' | 'jogos' | 'banda' | 'instrumentos' | 'zoeira' | 'gírias' | 'rpg';

export interface Compromisso {
  id?: number;
  titulo: string;
  data: string; // formato YYYY-MM-DD
  hora: string; // formato HH:MM
  solicitante: string;
  status: StatusCompromisso;
  criadoEm?: string;
}

export interface Recado {
  id?: number;
  nomeAmigo: string;
  mensagem: string;
  prioridade: PrioridadeRecado;
  criadoEm: string;
  lido: boolean;
}

export interface Memoria {
  id?: number;
  categoria: CategoriaMemoria;
  palavrasChave: string[];
  conteudo: string;
}

export interface ToolCallExecution {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  timestamp: string;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'fred_ia' | 'system';
  authorName?: string;
  text: string;
  toolCalls?: ToolCallExecution[];
  timestamp: string;
}

export interface DashboardData {
  agenda: Compromisso[];
  recados: Recado[];
  totalMemorias: number;
}
