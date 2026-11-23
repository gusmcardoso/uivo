import http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import zlib from 'node:zlib';

/** Duração de cada etapa da requisição, em milissegundos. */
export interface Timings {
  /** Tempo gasto nos saltos de redirecionamento antes da página final. */
  redirect: number;
  dns: number;
  connect: number;
  tls: number;
  /** Espera pelo primeiro byte depois da conexão pronta (processamento no servidor). */
  wait: number;
  download: number;
  total: number;
}

export interface HttpResult {
  ok: boolean;
  statusCode: number | null;
  /** Tempo até o primeiro byte da página final, incluindo redirecionamentos e conexão. */
  responseMs: number;
  error: string | null;
  timings?: Timings | null;
  /** Bytes transferidos (comprimidos, como vieram pela rede). */
  bytes?: number | null;
  encoding?: string | null;
  redirects?: number;
  finalUrl?: string | null;
}

export interface HttpOptions {
  keyword?: string | null;
  timeoutMs?: number;
}

const USER_AGENT = 'Uptrue/0.4 (+https://github.com/gusmcardoso/uptrue)';
const MAX_REDIRECTS = 5;
/** Download máximo medido; acima disso a transferência é interrompida (protege o monitor). */
const MAX_BYTES = 5 * 1024 * 1024;
/** Quanto do corpo é guardado para procurar a palavra-chave. */
const KEYWORD_BYTES = 2 * 1024 * 1024;
/** Teto da descompressão: impede que uma "bomba de compressão" esgote a memória do monitor. */
const MAX_DECODED = 10 * 1024 * 1024;

interface Hop {
  status: number;
  location: string | null;
  encoding: string;
  dns: number;
  connect: number;
  tls: number;
  wait: number;
  download: number;
  bytes: number;
  body: Buffer;
}

class CheckError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * Um salto HTTP numa conexão nova (agent: false), para medir DNS, TCP e TLS de verdade:
 * com conexão reaproveitada, essas etapas apareceriam como zero.
 */
function hop(url: URL, keepBody: boolean, deadline: number): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const t0 = performance.now();
    let tLookup: number | undefined;
    let tConnect: number | undefined;
    let tSecure: number | undefined;

    const req = client.request(url, {
      method: 'GET',
      agent: false,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*', 'accept-encoding': 'gzip, deflate, br' },
    });
    const timer = setTimeout(
      () => req.destroy(new CheckError('TIMEOUT')),
      Math.max(0, deadline - performance.now()),
    );

    req.on('socket', (socket: Socket) => {
      socket.once('lookup', () => {
        tLookup = performance.now();
      });
      socket.once('connect', () => {
        tConnect = performance.now();
      });
      socket.once('secureConnect', () => {
        tSecure = performance.now();
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.on('response', (res) => {
      const tResponse = performance.now();
      const phases = () => {
        const connectStart = tLookup ?? t0;
        const ready = tSecure ?? tConnect ?? t0;
        return {
          dns: tLookup ? tLookup - t0 : 0,
          connect: tConnect ? tConnect - connectStart : 0,
          tls: tSecure && tConnect ? tSecure - tConnect : 0,
          wait: tResponse - ready,
        };
      };
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === 'string' ? res.headers.location : null;
      const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();

      // Redirecionamento: não baixa o corpo, só segue para o próximo salto.
      if (status >= 300 && status < 400 && location) {
        clearTimeout(timer);
        res.destroy();
        resolve({ status, location, encoding, ...phases(), download: 0, bytes: 0, body: Buffer.alloc(0) });
        return;
      }

      let bytes = 0;
      let kept = 0;
      const chunks: Buffer[] = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({
          status,
          location,
          encoding,
          ...phases(),
          download: performance.now() - tResponse,
          bytes,
          body: Buffer.concat(chunks),
        });
      };
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (keepBody && kept < KEYWORD_BYTES) {
          chunks.push(chunk);
          kept += chunk.length;
        }
        if (bytes >= MAX_BYTES) {
          finish();
          res.destroy();
        }
      });
      res.on('end', finish);
      res.on('error', (err) => {
        if (done) return;
        clearTimeout(timer);
        reject(err);
      });
    });

    req.end();
  });
}

/** Descomprime o corpo (tolerando o corte em KEYWORD_BYTES) para procurar a palavra-chave. */
function decode(body: Buffer, encoding: string): string {
  try {
    if (encoding === 'gzip')
      return zlib
        .gunzipSync(body, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_DECODED })
        .toString();
    if (encoding === 'deflate')
      return zlib
        .inflateSync(body, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_DECODED })
        .toString();
    if (encoding === 'br') {
      return zlib
        .brotliDecompressSync(body, {
          finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
          maxOutputLength: MAX_DECODED,
        })
        .toString();
    }
  } catch {
    // Corpo corrompido ou cortado demais: segue com o texto cru
  }
  return body.toString();
}

const round = (ms: number) => Math.max(0, Math.round(ms));

/** GET seguindo redirecionamentos, com o tempo de cada etapa; opcionalmente exige uma palavra-chave. */
export async function checkHttp(url: string, options: HttpOptions = {}): Promise<HttpResult> {
  const start = performance.now();
  const deadline = start + (options.timeoutMs ?? 15_000);
  let current = new URL(url);
  let redirects = 0;

  try {
    for (;;) {
      const hopStart = performance.now();
      const h = await hop(current, Boolean(options.keyword), deadline);

      if (h.location && h.status >= 300 && h.status < 400) {
        if (redirects >= MAX_REDIRECTS) {
          return {
            ok: false,
            statusCode: h.status,
            responseMs: round(performance.now() - start),
            error: 'Redirecionamentos demais (possível loop)',
            timings: null,
            bytes: null,
            encoding: null,
            redirects,
            finalUrl: current.href,
          };
        }
        redirects++;
        current = new URL(h.location, current);
        continue;
      }

      const redirectMs = hopStart - start;
      const timings: Timings = {
        redirect: round(redirectMs),
        dns: round(h.dns),
        connect: round(h.connect),
        tls: round(h.tls),
        wait: round(h.wait),
        download: round(h.download),
        total: round(performance.now() - start),
      };
      let error: string | null = null;
      if (h.status < 200 || h.status >= 300) error = `HTTP ${h.status}`;
      else if (options.keyword && !decode(h.body, h.encoding).includes(options.keyword)) {
        error = `Palavra-chave "${options.keyword}" não encontrada`;
      }
      return {
        ok: error === null,
        statusCode: h.status,
        responseMs: round(redirectMs + h.dns + h.connect + h.tls + h.wait),
        error,
        timings,
        bytes: h.bytes,
        encoding: h.encoding || null,
        redirects,
        finalUrl: current.href,
      };
    }
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      responseMs: round(performance.now() - start),
      error: describeError(err),
      timings: null,
      bytes: null,
      encoding: null,
      redirects,
      finalUrl: null,
    };
  }
}

function describeError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const code = e.code ?? '';
  if (code === 'TIMEOUT') return 'Tempo de resposta esgotado';
  if (code === 'ENOTFOUND') return 'Domínio não encontrado (DNS)';
  if (code === 'EAI_AGAIN') return 'Falha temporária de DNS';
  if (code === 'ECONNREFUSED') return 'Conexão recusada';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'Conexão interrompida';
  if (code === 'ETIMEDOUT') return 'Tempo de conexão esgotado';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Servidor inalcançável';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return `Certificado inválido (${code})`;
  if (code === 'ERR_INVALID_URL') return 'Endereço inválido';
  return code || e.message || String(err);
}
