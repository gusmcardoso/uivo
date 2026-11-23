/**
 * Reconhece páginas de desafio anti-bot (firewalls de aplicação e CDNs).
 *
 * O Uptrue não tenta resolver nem contornar esses desafios: só os identifica, para dizer
 * "a infraestrutura respondeu, mas o conteúdo não pode ser lido" em vez de acusar queda falsa.
 * A verificação completa fica para quando o dono do site libera o monitor (cabeçalho secreto,
 * IP permitido ou um endereço de saúde fora do desafio).
 */

/** Status com que os desafios costumam responder. Outros códigos nunca são tratados como desafio. */
const CHALLENGE_STATUS = new Set([403, 429, 503]);

type Header = (name: string) => string | undefined;

interface Signature {
  provider: string;
  match: (h: Header, body: string) => boolean;
}

const SIGNATURES: Signature[] = [
  { provider: 'Vercel', match: (h) => /challenge|deny/i.test(h('x-vercel-mitigated') ?? '') },
  {
    provider: 'Cloudflare',
    match: (h, body) =>
      /challenge/i.test(h('cf-mitigated') ?? '') ||
      (/cloudflare/i.test(h('server') ?? '') &&
        /(Just a moment|cf-chl|challenge-platform|Attention Required)/i.test(body)),
  },
  {
    provider: 'Sucuri',
    match: (h, body) => Boolean(h('x-sucuri-block')) || /Sucuri WebSite Firewall/i.test(body),
  },
  { provider: 'AWS WAF', match: (h) => /captcha|challenge|block/i.test(h('x-amzn-waf-action') ?? '') },
  {
    provider: 'DataDome',
    match: (h, body) => Boolean(h('x-datadome')) || /captcha-delivery\.com/i.test(body),
  },
  {
    provider: 'Akamai',
    match: (h, body) => /AkamaiGHost/i.test(h('server') ?? '') && /Reference #/i.test(body),
  },
  {
    provider: 'Wordfence',
    match: (_h, body) => /Wordfence/i.test(body) && /(blocked|bloqueado)/i.test(body),
  },
  {
    provider: 'proteção anti-bot',
    match: (_h, body) =>
      /(captcha|verify you are (a )?human|checking your browser|verificando seu navegador|are you a robot|enable javascript and cookies to continue)/i.test(
        body,
      ),
  },
];

/** Devolve o nome do provedor quando a resposta é um desafio anti-bot; senão, null. */
export function detectChallenge(status: number, header: Header, body: string): string | null {
  if (!CHALLENGE_STATUS.has(status)) return null;
  for (const s of SIGNATURES) if (s.match(header, body)) return s.provider;
  return null;
}

/** Como liberar o monitor em cada provedor (mostrado no painel e no alerta). */
export function challengeHelp(provider: string): string {
  const header =
    'Crie uma regra de liberação (bypass/skip) quando o cabeçalho secreto configurado no Uptrue estiver presente';
  const tips: Record<string, string> = {
    Vercel: `No painel da Vercel → Firewall: desligue o Attack Challenge Mode se não houver ataque, ou ${header.toLowerCase()} (Custom Rule com ação Bypass).`,
    Cloudflare: `Na Cloudflare → Security → WAF: ${header.toLowerCase()} (Custom Rule com ação Skip), ou libere o IP do servidor do Uptrue.`,
    Sucuri: 'No painel da Sucuri: adicione o IP do servidor do Uptrue à lista de permissão.',
    'AWS WAF': `No AWS WAF: ${header.toLowerCase()} (regra com ação Allow antes da regra de desafio).`,
    DataDome: 'No DataDome: adicione o IP ou o cabeçalho do Uptrue às exceções.',
    Akamai: 'No Akamai: adicione o IP do servidor do Uptrue à lista de permissão.',
    Wordfence: 'No WordPress → Wordfence → Firewall: adicione o IP do servidor do Uptrue aos IPs permitidos.',
  };
  return (
    tips[provider] ??
    `${header}, libere o IP do servidor do Uptrue ou monitore um endereço de saúde que fique fora do desafio.`
  );
}
