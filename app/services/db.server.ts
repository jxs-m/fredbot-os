import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { SEED_MEMORIAS } from '~/data/seeds';
import type { Compromisso, Recado, Memoria, DashboardData } from '~/types';

const DB_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const DB_PATH = path.join(DB_DIR, 'fredbot.db');

declare global {
  // eslint-disable-next-line no-var
  var __fredbotDbInstance: DatabaseSync | undefined;
}

function getDatabase(): DatabaseSync {
  if (process.env.NODE_ENV === 'production') {
    return initDatabase(new DatabaseSync(DB_PATH));
  }
  if (!global.__fredbotDbInstance) {
    global.__fredbotDbInstance = initDatabase(new DatabaseSync(DB_PATH));
  }
  return global.__fredbotDbInstance;
}

function initDatabase(db: DatabaseSync): DatabaseSync {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agenda (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo TEXT NOT NULL,
      data TEXT NOT NULL,
      hora TEXT NOT NULL,
      solicitante TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente_aprovacao',
      criado_em TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome_amigo TEXT NOT NULL,
      mensagem TEXT NOT NULL,
      prioridade TEXT NOT NULL DEFAULT 'normal',
      criado_em TEXT NOT NULL,
      lido INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS memoria_fatos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      categoria TEXT NOT NULL,
      palavras_chave TEXT NOT NULL,
      conteudo TEXT NOT NULL
    );
  `);

  // Sincronizar memórias históricas sem duplicar (agenda e recados começam vazios por padrão)
  const existingMemoriaRows = db.prepare('SELECT conteudo FROM memoria_fatos').all() as Array<{ conteudo: string }>;
  const memoriaSet = new Set(existingMemoriaRows.map((r) => r.conteudo));
  const insertMemoria = db.prepare(`
    INSERT INTO memoria_fatos (categoria, palavras_chave, conteudo)
    VALUES (?, ?, ?)
  `);
  for (const item of SEED_MEMORIAS) {
    if (!memoriaSet.has(item.conteudo)) {
      insertMemoria.run(item.categoria, item.palavrasChave.join(','), item.conteudo);
    }
  }

  return db;
}

export const db = getDatabase();

export function getDashboardData(): DashboardData {
  const agendaRows = db
    .prepare('SELECT id, titulo, data, hora, solicitante, status, criado_em as criadoEm FROM agenda ORDER BY data ASC, hora ASC')
    .all() as unknown as Compromisso[];

  const recadosRows = (
    db
      .prepare('SELECT id, nome_amigo as nomeAmigo, mensagem, prioridade, criado_em as criadoEm, lido FROM recados ORDER BY id DESC')
      .all() as unknown as Array<{ id: number; nomeAmigo: string; mensagem: string; prioridade: string; criadoEm: string; lido: number }>
  ).map((r) => ({
    ...r,
    prioridade: r.prioridade as 'normal' | 'urgente',
    lido: Boolean(r.lido),
  }));

  const countMemoria = db.prepare('SELECT COUNT(*) as total FROM memoria_fatos').get() as { total: number };

  return {
    agenda: agendaRows,
    recados: recadosRows,
    totalMemorias: countMemoria ? countMemoria.total : 0,
  };
}

/**
 * Confirma manualmente um compromisso pendente na Central do Fred.
 */
export function confirmarCompromisso(id: number): boolean {
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = db.prepare("UPDATE agenda SET status = 'confirmado' WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

/**
 * Alterna o estado lido/não lido de um recado na Central do Fred.
 */
export function alternarRecadoLido(id: number): boolean {
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = db.prepare('UPDATE recados SET lido = CASE WHEN lido = 1 THEN 0 ELSE 1 END WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}
