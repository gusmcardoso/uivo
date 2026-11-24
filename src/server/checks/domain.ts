/** Sufixos de segundo nível em que o domínio registrável tem três partes. */
const MULTI_PART = new Set([
  'com.br',
  'net.br',
  'org.br',
  'gov.br',
  'edu.br',
  'art.br',
  'blog.br',
  'eco.br',
  'emp.br',
  'ind.br',
  'inf.br',
  'tec.br',
  'app.br',
  'dev.br',
  'log.br',
  'adv.br',
  'eng.br',
  'med.br',
  'srv.br',
  'tv.br',
  'co.uk',
  'org.uk',
  'com.au',
  'com.ar',
  'com.mx',
  'com.pt',
]);

/** Domínios de plataformas: o vencimento é da plataforma, não do site. */
const PLATFORM = new Set([
  'vercel.app',
  'netlify.app',
  'github.io',
  'pages.dev',
  'railway.app',
  'onrender.com',
  'herokuapp.com',
  'fly.dev',
  'web.app',
  'firebaseapp.com',
  'azurewebsites.net',
  'cloudfront.net',
]);

export function registrableDomain(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) return null;
  const parts = host.split('.');
  const lastTwo = parts.slice(-2).join('.');
  return MULTI_PART.has(lastTwo) && parts.length >= 3 ? parts.slice(-3).join('.') : lastTwo;
}

export function parseRdapExpiration(json: unknown): number | null {
  const events = (json as { events?: { eventAction?: string; eventDate?: string }[] } | null)?.events ?? [];
  const date = events.find((e) => e.eventAction === 'expiration')?.eventDate;
  return date ? Date.parse(date) || null : null;
}

export interface DomainResult {
  domain: string | null;
  expiresAt: number | null;
  error: string | null;
}

const HEADERS = {
  accept: 'application/rdap+json, application/json',
  'user-agent': 'Uivo (+https://github.com/gusmcardoso/uivo)',
};
const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const FALLBACK = 'https://rdap.org/';
let bootstrap: { at: number; servers: Map<string, string> } | null = null;

/** Servidor RDAP oficial de cada extensão, pela lista da IANA (cache de 24 h). */
async function rdapServer(tld: string, fetchImpl: typeof fetch): Promise<string> {
  if (tld === 'br') return 'https://rdap.registro.br/';
  if (!bootstrap || Date.now() - bootstrap.at > 86_400_000) {
    try {
      const res = await fetchImpl(BOOTSTRAP_URL, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
      const json = (await res.json()) as { services: [string[], string[]][] };
      const servers = new Map<string, string>();
      for (const [tlds, urls] of json.services) {
        const https = urls.find((u) => u.startsWith('https://')) ?? urls[0];
        for (const t of tlds) servers.set(t, https.endsWith('/') ? https : `${https}/`);
      }
      bootstrap = { at: Date.now(), servers };
    } catch {
      return FALLBACK;
    }
  }
  return bootstrap.servers.get(tld) ?? FALLBACK;
}

/** Vencimento do domínio via RDAP no servidor oficial da extensão (.br: Registro.br). */
export async function checkDomain(url: string, fetchImpl: typeof fetch = fetch): Promise<DomainResult> {
  const domain = registrableDomain(new URL(url).hostname);
  if (!domain) return { domain, expiresAt: null, error: 'Endereço sem domínio registrável' };
  if (PLATFORM.has(domain)) {
    return { domain, expiresAt: null, error: 'Domínio de plataforma (sem vencimento próprio)' };
  }
  try {
    const base = await rdapServer(domain.split('.').pop() ?? '', fetchImpl);
    const res = await fetchImpl(`${base}domain/${domain}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { domain, expiresAt: null, error: `RDAP respondeu ${res.status}` };
    const expiresAt = parseRdapExpiration(await res.json());
    return { domain, expiresAt, error: expiresAt ? null : 'RDAP sem data de vencimento' };
  } catch (err) {
    return { domain, expiresAt: null, error: (err as Error).message };
  }
}
