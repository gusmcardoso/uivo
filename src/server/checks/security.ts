import tls from 'node:tls';
import { registrableDomain } from './domain.ts';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  fix: string;
}

export interface AuditResult {
  score: number;
  findings: Finding[];
  passed: string[];
  scriptHosts: string[];
  error: string | null;
}

/** Pontos descontados da nota (100) por achado. */
const PENALTY: Record<Severity, number> = { critical: 40, high: 20, medium: 10, low: 4 };

export function scoreOf(findings: Finding[]): number {
  return Math.max(0, 100 - findings.reduce((sum, f) => sum + PENALTY[f.severity], 0));
}

const USER_AGENT = 'Uptrue-Audit (+https://github.com/gusmcardoso/uptrue)';
const MAX_BODY = 256 * 1024;

interface Res {
  status: number;
  headers: Headers;
  body: string;
  bytes: Uint8Array;
  url: string;
}

async function readLimited(res: Response): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BODY) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(size, MAX_BODY));
  let offset = 0;
  for (const c of chunks) {
    const part = c.subarray(0, out.length - offset);
    out.set(part, offset);
    offset += part.length;
    if (offset >= out.length) break;
  }
  return out;
}

async function get(
  url: string,
  fetchImpl: typeof fetch,
  redirect: RequestRedirect = 'follow',
): Promise<Res | null> {
  try {
    const res = await fetchImpl(url, {
      redirect,
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    const bytes = await readLimited(res);
    return {
      status: res.status,
      headers: res.headers,
      body: new TextDecoder().decode(bytes),
      bytes,
      url: res.url || url,
    };
  } catch {
    return null;
  }
}

const isHtml = (r: Res) =>
  (r.headers.get('content-type') ?? '').includes('text/html') ||
  /^\s*<(!doctype|html|head|body)/i.test(r.body);

const startsWith = (bytes: Uint8Array, sig: number[]) => sig.every((b, i) => bytes[i] === b);

interface SensitiveFile {
  id: string;
  paths: string[];
  severity: Severity;
  title: string;
  fix: string;
  /** Confirma pelo conteúdo: evita falso positivo em sites que respondem 200 para qualquer endereço. */
  match: (r: Res) => boolean;
}

const SENSITIVE: SensitiveFile[] = [
  {
    id: 'env-exposed',
    paths: ['/.env'],
    severity: 'critical',
    title: 'Arquivo .env exposto',
    fix: 'Bloqueie arquivos ocultos no servidor web e troque todas as senhas e chaves que estavam no arquivo.',
    match: (r) => !isHtml(r) && /^[A-Z][A-Z0-9_]*\s*=/m.test(r.body),
  },
  {
    id: 'git-exposed',
    paths: ['/.git/config', '/.git/HEAD'],
    severity: 'critical',
    title: 'Repositório Git exposto',
    fix: 'Bloqueie /.git no servidor web: o código-fonte e todo o histórico podem ser baixados.',
    match: (r) => r.body.includes('[core]') || /^ref: refs\//.test(r.body),
  },
  {
    id: 'wpconfig-backup',
    paths: ['/wp-config.php.bak', '/wp-config.php~', '/wp-config.old', '/wp-config.php.save'],
    severity: 'critical',
    title: 'Backup do wp-config.php exposto',
    fix: 'Apague o arquivo de backup do servidor e troque a senha do banco de dados.',
    match: (r) => r.body.includes('DB_PASSWORD'),
  },
  {
    id: 'sql-dump',
    paths: ['/backup.sql', '/dump.sql', '/database.sql', '/db.sql'],
    severity: 'critical',
    title: 'Dump do banco de dados exposto',
    fix: 'Remova o arquivo da pasta pública e guarde backups fora do servidor web.',
    match: (r) => !isHtml(r) && /(CREATE TABLE|INSERT INTO)/i.test(r.body),
  },
  {
    id: 'zip-backup',
    paths: ['/backup.zip', '/site.zip', '/www.zip'],
    severity: 'high',
    title: 'Arquivo de backup exposto',
    fix: 'Remova o arquivo compactado da pasta pública.',
    match: (r) => startsWith(r.bytes, [0x50, 0x4b, 0x03, 0x04]),
  },
  {
    id: 'htpasswd',
    paths: ['/.htpasswd'],
    severity: 'high',
    title: 'Arquivo .htpasswd exposto',
    fix: 'Bloqueie o acesso ao arquivo e troque as senhas listadas nele.',
    match: (r) => !isHtml(r) && /^[\w.-]+:\S{4,}$/m.test(r.body),
  },
  {
    id: 'phpinfo',
    paths: ['/phpinfo.php', '/info.php'],
    severity: 'medium',
    title: 'Página phpinfo() exposta',
    fix: 'Apague o arquivo: ele revela versões, caminhos e configurações do servidor.',
    match: (r) => r.body.includes('PHP Version') && /phpinfo/i.test(r.body),
  },
  {
    id: 'server-status',
    paths: ['/server-status'],
    severity: 'medium',
    title: 'Status interno do Apache exposto',
    fix: 'Restrinja /server-status a endereços internos.',
    match: (r) => r.body.includes('Apache Server Status'),
  },
  {
    id: 'ds-store',
    paths: ['/.DS_Store'],
    severity: 'low',
    title: 'Arquivo .DS_Store exposto',
    fix: 'Apague o arquivo: ele lista nomes de arquivos e pastas do site.',
    match: (r) => startsWith(r.bytes, [0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31]),
  },
];

const SPAM =
  /(hacked by|defaced by|slot gacor|judi online|situs slot|casino online|apostas? online gr[aá]tis|viagra|cialis)/i;

export function scriptHostsOf(html: string, siteHost: string): string[] {
  const own = registrableDomain(siteHost) ?? siteHost;
  const hosts = new Set<string>();
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    try {
      const host = new URL(m[1], `https://${siteHost}`).hostname.toLowerCase();
      if ((registrableDomain(host) ?? host) !== own) hosts.add(host);
    } catch {
      // src inválido: ignora
    }
  }
  return [...hosts].sort();
}

function tlsProtocol(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false, timeout: 8_000 },
      () => {
        const protocol = socket.getProtocol();
        socket.end();
        resolve(protocol);
      },
    );
    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });
    socket.on('error', () => resolve(null));
  });
}

/**
 * Auditoria passiva: só lê o que qualquer visitante já consegue acessar
 * (página inicial, cabeçalhos e endereços públicos conhecidos). Nada é enviado ao site além de GETs.
 */
export async function auditSecurity(url: string, fetchImpl: typeof fetch = fetch): Promise<AuditResult> {
  const target = new URL(url);
  const origin = target.origin;
  const findings: Finding[] = [];
  const passed: string[] = [];
  const add = (f: Finding) => findings.push(f);
  const ok = (label: string) => passed.push(label);

  const page = await get(url, fetchImpl);
  if (!page) {
    return { score: 0, findings: [], passed: [], scriptHosts: [], error: 'Não foi possível acessar o site' };
  }
  const finalUrl = new URL(page.url);
  const https = finalUrl.protocol === 'https:';
  const h = (name: string) => page.headers.get(name);

  // ─── HTTPS ──────────────────────────────────────────────────────────────
  if (!https) {
    add({
      id: 'no-https',
      severity: 'high',
      title: 'Site sem HTTPS',
      detail: 'A página é servida sem criptografia: senhas e formulários trafegam em texto puro.',
      fix: 'Ative um certificado (Let’s Encrypt é gratuito) e redirecione todo o tráfego para HTTPS.',
    });
  } else {
    ok('HTTPS ativo');
    const plain = await get(`http://${finalUrl.host}/`, fetchImpl, 'manual');
    const location = plain?.headers.get('location') ?? '';
    if (plain && plain.status >= 200 && plain.status < 300) {
      add({
        id: 'no-https-redirect',
        severity: 'medium',
        title: 'Versão sem HTTPS continua acessível',
        detail: `http://${finalUrl.host}/ responde ${plain.status} em vez de redirecionar para HTTPS.`,
        fix: 'Configure um redirecionamento permanente (301) de HTTP para HTTPS.',
      });
    } else if (plain && location.startsWith('https://')) {
      ok('HTTP redireciona para HTTPS');
    }

    const protocol = await tlsProtocol(finalUrl.hostname, Number(finalUrl.port) || 443);
    if (protocol && ['TLSv1', 'TLSv1.1', 'SSLv3'].includes(protocol)) {
      add({
        id: 'old-tls',
        severity: 'high',
        title: `Protocolo ${protocol} obsoleto`,
        detail: 'O servidor negociou uma versão de TLS com falhas conhecidas.',
        fix: 'Desative TLS 1.0/1.1 e mantenha só TLS 1.2 e 1.3.',
      });
    } else if (protocol) {
      ok(`Criptografia ${protocol}`);
    }

    const hsts = h('strict-transport-security') ?? '';
    const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
    if (maxAge >= 15_552_000) ok('HSTS');
    else {
      add({
        id: 'hsts',
        severity: 'medium',
        title: hsts ? 'HSTS com validade curta' : 'HSTS ausente',
        detail: 'Sem HSTS, o navegador pode ser levado a acessar a versão sem criptografia.',
        fix: 'Envie Strict-Transport-Security: max-age=31536000; includeSubDomains',
      });
    }

    if (/<(script|link|iframe|img)[^>]+(src|href)=["']http:\/\//i.test(page.body)) {
      add({
        id: 'mixed-content',
        severity: 'medium',
        title: 'Conteúdo misto (HTTP dentro de HTTPS)',
        detail: 'A página carrega recursos sem criptografia, que o navegador pode bloquear ou expor.',
        fix: 'Troque os endereços http:// dos recursos por https://.',
      });
    }
  }

  // ─── Cabeçalhos de segurança ────────────────────────────────────────────
  const csp = h('content-security-policy') ?? '';
  if (csp) ok('Content-Security-Policy');
  else {
    add({
      id: 'csp',
      severity: 'low',
      title: 'Content-Security-Policy ausente',
      detail: 'Sem CSP, um script injetado (XSS) roda sem restrição.',
      fix: "Comece com Content-Security-Policy: default-src 'self' e libere só o necessário.",
    });
  }
  if (h('x-frame-options') || /frame-ancestors/i.test(csp)) ok('Proteção contra clickjacking');
  else {
    add({
      id: 'frame',
      severity: 'medium',
      title: 'Página pode ser embutida por outros sites',
      detail: 'Sem X-Frame-Options ou frame-ancestors, o site pode ser usado em ataques de clickjacking.',
      fix: "Envie X-Frame-Options: SAMEORIGIN (ou frame-ancestors 'self' na CSP).",
    });
  }
  if ((h('x-content-type-options') ?? '').toLowerCase() === 'nosniff') ok('X-Content-Type-Options');
  else {
    add({
      id: 'nosniff',
      severity: 'low',
      title: 'X-Content-Type-Options ausente',
      detail: 'O navegador pode interpretar arquivos com um tipo diferente do declarado.',
      fix: 'Envie X-Content-Type-Options: nosniff',
    });
  }
  if (h('referrer-policy')) ok('Referrer-Policy');
  else {
    add({
      id: 'referrer',
      severity: 'low',
      title: 'Referrer-Policy ausente',
      detail: 'Endereços completos (com parâmetros) podem vazar para sites externos.',
      fix: 'Envie Referrer-Policy: strict-origin-when-cross-origin',
    });
  }
  const banner = [h('server'), h('x-powered-by')].filter((v): v is string => Boolean(v && /\d/.test(v)));
  if (banner.length) {
    add({
      id: 'version-banner',
      severity: 'low',
      title: 'Versão do servidor exposta',
      detail: `Cabeçalhos revelam: ${banner.join(', ')}. Facilita procurar falhas conhecidas daquela versão.`,
      fix: 'Oculte as versões (ex.: ServerTokens Prod no Apache, server_tokens off no Nginx, expose_php Off no PHP).',
    });
  }

  // ─── Conteúdo da página ─────────────────────────────────────────────────
  const spam = SPAM.exec(page.body);
  if (spam) {
    add({
      id: 'suspicious-content',
      severity: 'critical',
      title: 'Possível invasão: conteúdo suspeito na página',
      detail: `Foi encontrado o termo "${spam[1]}", comum em sites invadidos ou com spam injetado.`,
      fix: 'Verifique o código e o banco do site, atualize plataforma e plugins e troque as senhas de acesso.',
    });
  }
  const listing = async (path: string) => {
    const r = path === '/' ? page : await get(origin + path, fetchImpl);
    return r?.status === 200 && /<title>Index of \//i.test(r.body);
  };
  const wordpress = page.body.includes('/wp-content/');
  if ((await listing('/')) || (wordpress && (await listing('/wp-content/uploads/')))) {
    add({
      id: 'dir-listing',
      severity: 'medium',
      title: 'Listagem de diretório ativa',
      detail: 'Qualquer pessoa consegue navegar pelas pastas e baixar arquivos do site.',
      fix: 'Desative a listagem (Options -Indexes no Apache, autoindex off no Nginx).',
    });
  }

  // ─── Arquivos sensíveis ─────────────────────────────────────────────────
  const exposed = await Promise.all(
    SENSITIVE.map(async (file) => {
      for (const path of file.paths) {
        const r = await get(origin + path, fetchImpl, 'manual');
        if (r?.status === 200 && file.match(r)) return { file, path };
      }
      return null;
    }),
  );
  for (const hit of exposed) {
    if (!hit) continue;
    add({
      id: hit.file.id,
      severity: hit.file.severity,
      title: hit.file.title,
      detail: `${origin}${hit.path} pode ser baixado por qualquer pessoa.`,
      fix: hit.file.fix,
    });
  }
  if (exposed.every((e) => e === null)) ok('Nenhum arquivo sensível exposto');

  return {
    score: scoreOf(findings),
    findings,
    passed,
    scriptHosts: scriptHostsOf(page.body, finalUrl.hostname),
    error: null,
  };
}
