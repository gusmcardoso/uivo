import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { buildApp } from '../src/server/app.ts';
import { runSecurityAudit } from '../src/server/audit.ts';
import { detectChallenge } from '../src/server/checks/challenge.ts';
import { checkHttp } from '../src/server/checks/http.ts';
import { auditSecurity } from '../src/server/checks/security.ts';
import { getSite, openDb } from '../src/server/db.ts';
import { runSiteCheck } from '../src/server/monitor.ts';

const headers = (h: Record<string, string>) => (name: string) => h[name];

describe('reconhecimento de desafios anti-bot', () => {
  it('reconhece cada provedor pela assinatura', () => {
    // Resposta real capturada do portfólio na Vercel
    assert.equal(detectChallenge(403, headers({ 'x-vercel-mitigated': 'challenge' }), ''), 'Vercel');
    assert.equal(detectChallenge(403, headers({ 'cf-mitigated': 'challenge' }), ''), 'Cloudflare');
    assert.equal(
      detectChallenge(503, headers({ server: 'cloudflare' }), '<title>Just a moment...</title>'),
      'Cloudflare',
    );
    assert.equal(detectChallenge(403, headers({ 'x-sucuri-block': '1' }), ''), 'Sucuri');
    assert.equal(detectChallenge(403, headers({ 'x-amzn-waf-action': 'captcha' }), ''), 'AWS WAF');
    assert.equal(detectChallenge(429, headers({ 'x-datadome': 'protected' }), ''), 'DataDome');
    assert.equal(
      detectChallenge(403, headers({ server: 'AkamaiGHost' }), 'Access Denied. Reference #18.abc'),
      'Akamai',
    );
    assert.equal(detectChallenge(403, headers({}), 'Your access was blocked by Wordfence'), 'Wordfence');
    assert.equal(
      detectChallenge(403, headers({}), '<p>Please complete the CAPTCHA</p>'),
      'proteção anti-bot',
    );
  });

  it('403 comum não é desafio', () => {
    assert.equal(detectChallenge(403, headers({ server: 'nginx' }), '<h1>403 Forbidden</h1>'), null);
    assert.equal(detectChallenge(403, headers({ server: 'cloudflare' }), '<h1>Acesso negado</h1>'), null);
  });

  it('só considera status de bloqueio: 200 com a palavra "captcha" não é desafio', () => {
    assert.equal(detectChallenge(200, headers({}), 'Formulário com captcha'), null);
    assert.equal(detectChallenge(500, headers({ 'x-vercel-mitigated': 'challenge' }), ''), null);
  });
});

describe('verificação em camadas', () => {
  let server: Server;
  let base: string;
  const SECRET = 'segredo-de-liberacao-123';

  before(async () => {
    // Imita o firewall da Vercel: desafia quem não tem o cabeçalho de liberação
    server = createServer((req, res) => {
      if (req.headers['x-uivo-key'] === SECRET) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<h1>Gustavo Martins</h1> portfólio');
      }
      if (req.url === '/forbidden') {
        res.writeHead(403, { 'content-type': 'text/html' });
        return res.end('<h1>403 Forbidden</h1>');
      }
      res.writeHead(403, { 'content-type': 'text/html', 'x-vercel-mitigated': 'challenge' });
      res.end('<html><body>Estamos verificando seu navegador</body></html>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it('desafio reconhecido = no ar, com conteúdo não verificado (palavra-chave não é cobrada)', async () => {
    const r = await checkHttp(`${base}/`, { keyword: 'Gustavo' });
    assert.equal(r.ok, true);
    assert.equal(r.statusCode, 403);
    assert.equal(r.challenge, 'Vercel');
    assert.equal(r.error, null);
  });

  it('403 comum continua sendo falha', async () => {
    const r = await checkHttp(`${base}/forbidden`);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'HTTP 403');
    assert.equal(r.challenge, null);
  });

  it('com o cabeçalho de liberação, a verificação volta a ser completa', async () => {
    const r = await checkHttp(`${base}/`, { keyword: 'Gustavo', headers: { 'x-uivo-key': SECRET } });
    assert.equal(r.ok, true);
    assert.equal(r.statusCode, 200);
    assert.equal(r.challenge, null);
    const wrong = await checkHttp(`${base}/`, { keyword: 'Gustavo', headers: { 'x-uivo-key': 'errado' } });
    assert.equal(wrong.challenge, 'Vercel');
  });

  it('auditoria não avalia a página do firewall', async () => {
    const r = await auditSecurity(`${base}/`);
    assert.match(r.error ?? '', /desafio anti-bot \(Vercel\)/);
    assert.equal(r.findings.length, 0);
    const ok = await auditSecurity(`${base}/`, fetch, { 'x-uivo-key': SECRET });
    assert.equal(ok.error, null);
  });

  describe('no monitor', () => {
    let db: ReturnType<typeof openDb>;
    let alerts: string[];
    beforeEach(() => {
      db = openDb(':memory:');
      alerts = [];
      db.prepare('INSERT INTO sites (name, url, created_at) VALUES (?, ?, 0)').run('Portfólio', `${base}/`);
    });
    const check = async () => {
      const site = getSite(db, 1);
      assert.ok(site);
      await runSiteCheck(site, { db, notify: async (t) => void alerts.push(t) });
      return getSite(db, 1);
    };

    it('não abre incidente e avisa uma única vez sobre o bloqueio', async () => {
      await check();
      await check();
      const site = await check();
      assert.equal(site?.status, 'up');
      assert.equal(site?.last_challenge, 'Vercel');
      const incidents = db.prepare('SELECT COUNT(*) AS n FROM incidents').get() as { n: number };
      assert.equal(incidents.n, 0);
      assert.equal(alerts.length, 1);
      assert.match(alerts[0], /firewall \(Vercel\)/);
      const stored = db.prepare('SELECT challenge FROM checks').all() as { challenge: string }[];
      assert.ok(stored.every((c) => c.challenge === 'Vercel'));
    });

    it('usa os cabeçalhos de liberação salvos no site', async () => {
      db.prepare('UPDATE sites SET custom_headers = ? WHERE id = 1').run(
        JSON.stringify({ 'x-uivo-key': SECRET }),
      );
      const site = await check();
      assert.equal(site?.last_challenge, null);
      assert.equal(alerts.length, 0);
    });

    it('auditoria barrada registra o motivo e não muda a nota', async () => {
      db.prepare('UPDATE sites SET security_score = 77 WHERE id = 1').run();
      const site = getSite(db, 1);
      assert.ok(site);
      await runSecurityAudit(site, { db, notify: async () => {} }, true);
      assert.equal(getSite(db, 1)?.security_score, 77);
      assert.match(getSite(db, 1)?.security_error ?? '', /desafio anti-bot/);
    });
  });
});

describe('cabeçalhos de liberação na API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie: string;

  beforeEach(async () => {
    app = await buildApp({
      db: openDb(':memory:'),
      authSecret: 'segredo-de-teste-com-tamanho-ok',
      runNow: async () => {},
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { email: 'admin@exemplo.com', password: 'senha-forte-123' },
    });
    const c = res.cookies.find((x) => x.name === 'uivo_session');
    cookie = `${c?.name}=${c?.value}`;
  });

  const create = (headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie },
      payload: { name: 'Loja', url: 'https://loja.com.br', headers },
    });

  it('salva, mas nunca devolve o valor; só o nome', async () => {
    const created = await create({ 'X-Uivo-Key': 'segredo-123' });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(created.json().custom_header_names, ['x-uivo-key']);
    assert.ok(!created.body.includes('segredo-123'));
    const list = await app.inject({ url: '/api/sites', headers: { cookie } });
    assert.ok(!list.body.includes('segredo-123'));
    assert.equal(list.json()[0].custom_headers, undefined);
  });

  it('valor vazio mantém o segredo salvo; omitir o nome remove', async () => {
    const id = (await create({ 'x-uivo-key': 'segredo-123' })).json().id;
    const patch = (headers: Record<string, string>) =>
      app.inject({ method: 'PATCH', url: `/api/sites/${id}`, headers: { cookie }, payload: { headers } });
    assert.deepEqual((await patch({ 'x-uivo-key': '' })).json().custom_header_names, ['x-uivo-key']);
    assert.deepEqual((await patch({})).json().custom_header_names, []);
  });

  it('recusa nomes reservados, nomes inválidos, quebra de linha e excesso', async () => {
    assert.equal((await create({ Host: 'evil.com' })).statusCode, 400);
    assert.equal((await create({ 'nome com espaço': 'x' })).statusCode, 400);
    assert.equal((await create({ 'x-a': 'linha1\r\nX-Injetado: 1' })).statusCode, 400);
    const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`x-h${i}`, 'v']));
    assert.equal((await create(many)).statusCode, 400);
  });
});
