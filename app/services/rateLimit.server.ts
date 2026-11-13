/**
 * Controle simples de requisições (Rate Limiter em memória por janela deslizante).
 * Equivalente ao papel do `express-rate-limit` para evitar spam e proteger a cota da API Gemini.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 15;

declare global {
  // eslint-disable-next-line no-var
  var __fredbotRateLimitStore: Map<string, number[]> | undefined;
}

function getStore(): Map<string, number[]> {
  if (!global.__fredbotRateLimitStore) {
    global.__fredbotRateLimitStore = new Map<string, number[]>();
  }
  return global.__fredbotRateLimitStore;
}

/**
 * Extrai um identificador de origem da requisição para controle de taxa.
 */
export function getClientIdentifier(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || 'local-client';
}

/**
 * Verifica e registra uma requisição dentro da janela configurada.
 */
export function checkRateLimit(
  clientId: string,
  maxRequests = DEFAULT_MAX_REQUESTS,
  windowMs = DEFAULT_WINDOW_MS
): RateLimitResult {
  const store = getStore();
  const now = Date.now();
  const windowStart = now - windowMs;

  const recentTimestamps = (store.get(clientId) ?? []).filter((ts) => ts > windowStart);

  if (recentTimestamps.length >= maxRequests) {
    const oldestInWindow = recentTimestamps[0] ?? now;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + windowMs - now) / 1000));
    store.set(clientId, recentTimestamps);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds,
    };
  }

  recentTimestamps.push(now);
  store.set(clientId, recentTimestamps);

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - recentTimestamps.length),
    retryAfterSeconds: 0,
  };
}

/**
 * Limpa os registros de taxa (útil em testes automatizados).
 */
export function resetRateLimit(clientId?: string): void {
  const store = getStore();
  if (clientId) {
    store.delete(clientId);
  } else {
    store.clear();
  }
}

