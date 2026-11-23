import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { acceptScripts, latestAudit, runSecurityAudit } from '../src/server/audit.ts';
import { type AuditResult, auditSecurity, scoreOf, scriptHostsOf } from '../src/server/checks/security.ts';
import { getSite, openDb } from '../src/server/db.ts';
import { healthScore } from '../src/server/health.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function serve(handler: Handler): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server };
}

const SAFE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'self'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

describe('auditoria de segurança', () => {
  const servers: Server[] = [];
  let vulnerable: string;
  let soft404: string;
  let defaced: string;

  before(async () => {
    const v = await serve((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html', server: 'Apache/2.4.41 (Ubuntu)' });
        return res.end('<html><script src="https://cdn.estranho.xyz/a.js"></script>Loja</html>');
      }
      if (req.url === '/.env') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('APP_KEY=base64:abc\nDB_PASSWORD=segredo\n');
      }
      if (req.url === '/.git/config') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('[core]\n\trepositoryformatversion = 0\n');
      }
      res.writeHead(404).end();
    });
    // "Soft 404": responde 200 com HTML para QUALQUER endereço (comum em SPAs e hospedagens)
    const s = await serve((_req, res) => {
      res.writeHead(200, SAFE_HEADERS);
      res.end('<!doctype html><html><body>Página do site. APP_KEY=nao-e-env</body></html>');
    });
    const d = await serve((_req, res) => {
      res.writeHead(200, SAFE_HEADERS);
      res.end('<html><body><h1>Hacked by Fulano</h1></body></html>');
    });
    servers.push(v.server, s.server, d.server);
    [vulnerable, soft404, defaced] = [v.url, s.url, d.url];
  });

  after(() => {
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
  });

  const ids = (r: AuditResult) => r.findings.map((f) => f.id).sort();

  it('encontra .env e .git expostos, cabeçalhos ausentes e versão do servidor', async () => {
    const r = await auditSecurity(vulnerable);
    for (const id of [
      'env-exposed',
      'git-exposed',
      'no-https',
      'csp',
      'frame',
      'nosniff',
      'referrer',
      'version-banner',
    ]) {
      assert.ok(ids(r).includes(id), `faltou ${id}`);
    }
    assert.equal(r.score, 0);
    assert.deepEqual(r.scriptHosts, ['cdn.estranho.xyz']);
  });

  it('site que responde 200 para tudo não gera falso positivo de arquivo exposto', async () => {
    const r = await auditSecurity(soft404);
    assert.deepEqual(ids(r), ['no-https']);
    assert.ok(r.passed.includes('Nenhum arquivo sensível exposto'));
    assert.equal(r.score, 80);
  });

  it('detecta conteúdo de invasão na página', async () => {
    const r = await auditSecurity(defaced);
    const f = r.findings.find((x) => x.id === 'suspicious-content');
    assert.equal(f?.severity, 'critical');
    assert.match(f?.detail ?? '', /hacked by/i);
  });

  it('site inacessível devolve erro sem nota', async () => {
    const r = await auditSecurity('http://127.0.0.1:9/');
    assert.equal(r.error, 'Não foi possível acessar o site');
  });
});

describe('nota e scripts', () => {
  it('desconta por gravidade e não fica negativa', () => {
    const f = (severity: 'critical' | 'high' | 'medium' | 'low') => ({
      id: severity,
      severity,
      title: '',
      detail: '',
      fix: '',
    });
    assert.equal(scoreOf([]), 100);
    assert.equal(scoreOf([f('medium'), f('low')]), 86);
    assert.equal(scoreOf([f('critical'), f('critical'), f('critical')]), 0);
  });

  it('lista só scripts de domínios de terceiros', () => {
    const html =
      '<script src="/app.js"></script><script src="https://cdn.loja.com.br/x.js"></script>' +
      '<script async src="https://www.googletagmanager.com/gtag.js"></script>';
    assert.deepEqual(scriptHostsOf(html, 'www.loja.com.br'), ['www.googletagmanager.com']);
  });
});

describe('auditoria agendada', () => {
  let db: ReturnType<typeof openDb>;
  let alerts: string[];
  let hosts: string[];
  let clock: number;
  const fakeAudit = async (): Promise<AuditResult> => ({
    score: 100,
    findings: [],
    passed: ['HTTPS ativo'],
    scriptHosts: hosts,
    error: null,
  });

  beforeEach(() => {
    db = openDb(':memory:');
    alerts = [];
    hosts = ['www.googletagmanager.com'];
    clock = Date.now();
    db.prepare("INSERT INTO sites (name, url, created_at) VALUES ('Loja', 'https://loja.com.br', 0)").run();
  });

  const audit = async (force = false) => {
    const site = getSite(db, 1);
    assert.ok(site);
    return runSecurityAudit(
      site,
      { db, notify: async (t) => void alerts.push(t), audit: fakeAudit, now: () => clock },
      force,
    );
  };

  it('primeira auditoria define a referência de scripts; script novo depois vira alerta', async () => {
    await audit();
    assert.equal(alerts.length, 0);
    assert.equal(getSite(db, 1)?.security_score, 100);

    hosts = ['www.googletagmanager.com', 'cdn.malicioso.xyz'];
    clock += 25 * 3_600_000;
    const r = await audit();
    assert.ok(r?.findings.some((f) => f.id === 'new-script:cdn.malicioso.xyz'));
    assert.equal(getSite(db, 1)?.security_score, 80);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /Novo script externo: cdn\.malicioso\.xyz/);

    clock += 25 * 3_600_000; // mesmo achado no dia seguinte: sem alerta repetido
    await audit();
    assert.equal(alerts.length, 1);
  });

  it('aceitar os scripts atuais limpa o achado e restaura a nota', async () => {
    await audit();
    hosts = ['www.googletagmanager.com', 'widget.chat.com'];
    await audit(true);
    const accepted = acceptScripts({ db }, getSite(db, 1) as NonNullable<ReturnType<typeof getSite>>);
    assert.equal(accepted?.score, 100);
    assert.equal(getSite(db, 1)?.security_score, 100);
    assert.equal(latestAudit({ db }, 1)?.findings.length, 0);
  });

  it('respeita o intervalo de 1 dia, a não ser que seja forçada', async () => {
    await audit();
    assert.equal(await audit(), null);
    assert.ok(await audit(true));
  });
});

describe('nota de saúde', () => {
  const now = Date.now();
  const DAY = 86_400_000;
  const base = {
    url: 'https://loja.com.br',
    check_domain: 1,
    ssl_expires_at: now + 60 * DAY,
    ssl_error: null,
    domain_expires_at: now + 200 * DAY,
    security_score: 100,
  };

  it('site perfeito tira 100', () => {
    assert.equal(healthScore(base, 100, now), 100);
  });

  it('segurança e uptime pesam 40 cada; validade 20', () => {
    assert.equal(healthScore({ ...base, security_score: 50 }, 100, now), 80);
    assert.equal(healthScore(base, 97.5, now), 80);
    assert.equal(healthScore({ ...base, ssl_expires_at: now + 5 * DAY }, 100, now), 95);
    assert.equal(healthScore({ ...base, url: 'http://loja.com.br' }, 100, now), 90);
  });

  it('sem auditoria, a nota usa só disponibilidade e validade', () => {
    assert.equal(healthScore({ ...base, security_score: null }, 100, now), 100);
    assert.equal(healthScore({ ...base, security_score: null }, null, now), null);
  });
});
