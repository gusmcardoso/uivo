export interface HttpResult {
  ok: boolean;
  statusCode: number | null;
  responseMs: number;
  error: string | null;
}

export interface HttpOptions {
  keyword?: string | null;
  timeoutMs?: number;
}

const USER_AGENT = 'Uptrue/0.3 (+https://github.com/gusmcardoso/uptrue)';

/** Requisição GET seguindo redirecionamentos; opcionalmente exige uma palavra-chave no HTML. */
export async function checkHttp(url: string, options: HttpOptions = {}): Promise<HttpResult> {
  const start = performance.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const responseMs = Math.round(performance.now() - start);
    let error: string | null = null;
    if (!res.ok) {
      error = `HTTP ${res.status}`;
      await res.body?.cancel();
    } else if (options.keyword) {
      const body = await res.text();
      if (!body.includes(options.keyword)) error = `Palavra-chave "${options.keyword}" não encontrada`;
    } else {
      await res.body?.cancel();
    }
    return { ok: error === null, statusCode: res.status, responseMs, error };
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      responseMs: Math.round(performance.now() - start),
      error: describeError(err),
    };
  }
}

function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'TimeoutError') return 'Tempo de resposta esgotado';
  const e = err as { cause?: { code?: string; message?: string }; message?: string };
  const code = e.cause?.code;
  if (code === 'ENOTFOUND') return 'Domínio não encontrado (DNS)';
  if (code === 'EAI_AGAIN') return 'Falha temporária de DNS';
  if (code === 'ECONNREFUSED') return 'Conexão recusada';
  if (code === 'ECONNRESET') return 'Conexão interrompida';
  if (code === 'UND_ERR_SOCKET') return 'Conexão encerrada pelo servidor';
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return 'Tempo de conexão esgotado';
  if (code?.includes('CERT')) return `Certificado inválido (${code})`;
  return code ?? e.cause?.message ?? e.message ?? String(err);
}
