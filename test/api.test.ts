import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { buildApp } from '../src/server/app.ts';
import { openDb } from '../src/server/db.ts';

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let checked: number[];
let db: ReturnType<typeof openDb>;

beforeEach(async () => {
  checked = [];
  db = openDb(':memory:');
  app = await buildApp({
    db,
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

describe('gráfico', () => {
  it('agrupa as checagens em faixas de tempo (divisão inteira)', async () => {
    const cookie = await setup();
    const id = Number(
      db.prepare("INSERT INTO sites (name, url, created_at) VALUES ('Loja', 'https://loja.com.br', 0)").run()
        .lastInsertRowid,
    );
    const bucket = Math.ceil((30 * 86_400_000) / 300); // faixa do período de 30 dias
    const start = Math.floor(Date.now() / bucket) * bucket - 10 * bucket;
    const insert = db.prepare('INSERT INTO checks (site_id, at, ok, response_ms) VALUES (?, ?, 1, ?)');
    insert.run(id, start + 1_000, 100);
    insert.run(id, start + 2_000, 300); // mesma faixa da anterior
    insert.run(id, start + bucket + 1_000, 200); // faixa seguinte
    const points = (
      await app.inject({ url: `/api/sites/${id}/checks?range=30d`, headers: { cookie } })
    ).json();
    assert.equal(points.length, 2);
    assert.deepEqual(
      points.map((p: { ms: number; n: number }) => [p.ms, p.n]),
      [
        [200, 2],
        [200, 1],
      ],
    );
  });
});

describe('tempo por etapa (API)', () => {
  it('devolve percentis, médias por etapa e a última checagem; queda não conta como lentidão', async () => {
    const cookie = await setup();
    const id = Number(
      db.prepare("INSERT INTO sites (name, url, created_at) VALUES ('Loja', 'https://loja.com.br', 0)").run()
        .lastInsertRowid,
    );
    const insert = db.prepare(
      `INSERT INTO checks (site_id, at, ok, response_ms, redirect_ms, dns_ms, connect_ms, tls_ms, wait_ms, download_ms, bytes)
       VALUES (?, ?, ?, ?, 0, 10, 20, 30, ?, 5, 1000)`,
    );
    const now = Date.now();
    for (let i = 1; i <= 10; i++) insert.run(id, now - i * 60_000, 1, 60 + i * 10, i * 10);
    insert.run(id, now - 30_000, 0, 15_000, 0); // queda (timeout): fora dos percentis
    db.prepare('UPDATE sites SET last_timing = ? WHERE id = ?').run(
      JSON.stringify({ timings: { dns: 10 }, encoding: 'br', redirects: 1 }),
      id,
    );

    const t = (await app.inject({ url: `/api/sites/${id}/timing?range=24h`, headers: { cookie } })).json();
    assert.equal(t.samples, 10);
    assert.equal(t.p50, 110);
    assert.equal(t.p95, 160);
    assert.equal(t.average.dns, 10);
    assert.equal(t.average.wait, 55);
    assert.equal(t.last.encoding, 'br');

    const points = (
      await app.inject({ url: `/api/sites/${id}/checks?range=24h`, headers: { cookie } })
    ).json();
    assert.ok(points.every((p: { dns: number | null }) => p.dns === 10 || p.dns === null));
  });

  it('a lista de sites não expõe campos internos', async () => {
    const cookie = await setup();
    db.prepare(
      "INSERT INTO sites (name, url, created_at, script_hosts, last_timing) VALUES ('X', 'https://x.com', 0, '[]', '{}')",
    ).run();
    const [site] = (await app.inject({ url: '/api/sites', headers: { cookie } })).json();
    assert.equal(site.script_hosts, undefined);
    assert.equal(site.last_timing, undefined);
  });
});
