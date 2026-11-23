import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { buildApp } from '../src/server/app.ts';
import { openDb } from '../src/server/db.ts';

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let checked: number[];

beforeEach(async () => {
  checked = [];
  app = await buildApp({
    db: openDb(':memory:'),
    authSecret: 'segredo-de-teste-com-tamanho-ok',
    runNow: async (id) => void checked.push(id),
  });
});

async function setup(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { email: 'Admin@Exemplo.com', password: 'senha-forte-123' },
  });
  assert.equal(res.statusCode, 200);
  const cookie = res.cookies.find((c) => c.name === 'uptrue_session');
  assert.ok(cookie);
  return `${cookie.name}=${cookie.value}`;
}

describe('API', () => {
  it('healthz responde', async () => {
    const res = await app.inject('/healthz');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  });

  it('primeiro acesso pede setup, que só pode ser feito uma vez', async () => {
    assert.deepEqual((await app.inject('/api/session')).json(), { authenticated: false, needsSetup: true });
    await setup();
    const again = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { email: 'outro@exemplo.com', password: 'outra-senha-123' },
    });
    assert.equal(again.statusCode, 409);
  });

  it('rotas de sites exigem login', async () => {
    assert.equal((await app.inject('/api/sites')).statusCode, 401);
  });

  it('login com senha errada é recusado; certa abre sessão', async () => {
    await setup();
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'admin@exemplo.com', password: 'errada-123' },
    });
    assert.equal(wrong.statusCode, 401);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'admin@exemplo.com', password: 'senha-forte-123' },
    });
    assert.equal(ok.statusCode, 200);
  });

  it('cookie adulterado não autentica', async () => {
    const cookie = await setup();
    const forged = cookie.replace(/=(\d+)\./, '=999.');
    assert.equal((await app.inject({ url: '/api/sites', headers: { cookie: forged } })).statusCode, 401);
  });

  it('cadastra, lista, edita e remove um site', async () => {
    const cookie = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie },
      payload: { name: 'Loja', url: 'https://loja.com.br', interval_sec: 120 },
    });
    assert.equal(created.statusCode, 201);
    const site = created.json();
    assert.deepEqual(checked, [site.id]); // checagem imediata ao cadastrar

    const list = await app.inject({ url: '/api/sites', headers: { cookie } });
    assert.equal(list.json().length, 1);

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/sites/${site.id}`,
      headers: { cookie },
      payload: { name: 'Loja Nova' },
    });
    assert.equal(edited.json().name, 'Loja Nova');

    const removed = await app.inject({ method: 'DELETE', url: `/api/sites/${site.id}`, headers: { cookie } });
    assert.equal(removed.statusCode, 204);
  });

  it('recusa URL inválida e intervalo abaixo de 30 s', async () => {
    const cookie = await setup();
    const badUrl = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie },
      payload: { name: 'X', url: 'ftp://x' },
    });
    assert.equal(badUrl.statusCode, 400);
    const badInterval = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie },
      payload: { name: 'X', url: 'https://x.com', interval_sec: 5 },
    });
    assert.equal(badInterval.statusCode, 400);
  });

  it('envia cabeçalhos de segurança', async () => {
    const res = await app.inject('/healthz');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.match(String(res.headers['content-security-policy']), /default-src 'self'/);
  });
});
