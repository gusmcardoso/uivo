import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/server/app.ts';
import { openDb } from '../src/server/db.ts';
import { parseProject, vercelClient } from '../src/server/vercel.ts';

const NOW = Date.UTC(2026, 10, 27, 15, 0, 0); // 27/11/2026

interface Call {
  url: URL;
  auth: string | null;
}

/** fetch falso: responde conforme o tipo de consulta e guarda o que foi pedido. */
function fakeFetch(handler: (url: URL) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fn, calls };
}

const okHandler = (url: URL) => {
  if (url.pathname.endsWith('/count'))
    return { status: 200, body: { data: { visitors: 321, pageviews: 900 } } };
  if (url.searchParams.get('by') === 'day')
    return {
      status: 200,
      body: {
        data: [
          { timestamp: '2026-11-26T00:00:00.000Z', visitors: 40, pageviews: 90 },
          { timestamp: '2026-11-27T00:00:00.000Z', visitors: 12, pageviews: 30 },
        ],
      },
    };
  return {
    status: 200,
    body: {
      data: [
        { timestamp: '2026-10-01T00:00:00.000Z', visitors: 800, pageviews: 2000 },
        { timestamp: '2026-11-01T00:00:00.000Z', visitors: 321, pageviews: 900 },
      ],
    },
  };
};

describe('visitantes da Vercel', () => {
  it('aceita "projeto" e "time/projeto"; recusa o resto', () => {
    assert.deepEqual(parseProject('portfolio'), { project: 'portfolio', team: null });
    assert.deepEqual(parseProject(' meu-time/portfolio '), { project: 'portfolio', team: 'meu-time' });
    assert.deepEqual(parseProject('team_abc123/prj_X1'), { project: 'prj_X1', team: 'team_abc123' });
    for (const bad of ['', '../etc', 'a/b/c', 'proj?x=1', 'proj&teamId=1', 'https://x', 'a b'])
      assert.equal(parseProject(bad), null, bad);
  });

  it('sem token ou sem projeto diz o que falta e não chama a Vercel', async () => {
    const { fn, calls } = fakeFetch(okHandler);
    assert.deepEqual(await vercelClient({ fetch: fn }).visitors('portfolio'), {
      configured: false,
      reason: 'token',
    });
    assert.deepEqual(await vercelClient({ token: 't', fetch: fn }).visitors(null), {
      configured: false,
      reason: 'project',
    });
    assert.equal(calls.length, 0);
  });

  it('monta os 30 dias, o mês corrente e os meses; usa teamId ou slug', async () => {
    const { fn, calls } = fakeFetch(okHandler);
    const client = vercelClient({ token: 'segredo-vercel', fetch: fn, now: () => NOW });
    const r = await client.visitors('team_abc/portfolio');
    assert.equal(r.configured, true);
    assert.ok('days' in r && r.error === null);
    assert.equal(r.days.length, 30);
    assert.equal(r.days[0].date, '2026-10-29');
    assert.deepEqual(r.days[29], { date: '2026-11-27', visitors: 12, pageviews: 30 });
    assert.deepEqual(r.days[28], { date: '2026-11-26', visitors: 40, pageviews: 90 });
    assert.equal(r.days[10].visitors, 0, 'dia sem visita entra com zero');
    assert.deepEqual(r.thisMonth, { visitors: 321, pageviews: 900 });
    assert.equal(r.months.length, 2);
    assert.equal(r.monthsLimited, false);

    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.equal(c.url.host, 'api.vercel.com');
      assert.equal(c.auth, 'Bearer segredo-vercel');
      assert.equal(c.url.searchParams.get('projectId'), 'portfolio');
      assert.equal(c.url.searchParams.get('teamId'), 'team_abc');
    }
    const count = calls.find((c) => c.url.pathname.endsWith('/count'));
    assert.equal(count?.url.searchParams.get('since'), '2026-11-01');

    const slug = fakeFetch(okHandler);
    await vercelClient({ token: 't', fetch: slug.fn, now: () => NOW }).visitors('meu-time/portfolio');
    assert.equal(slug.calls[0].url.searchParams.get('slug'), 'meu-time');
    assert.equal(slug.calls[0].url.searchParams.get('teamId'), null);
  });

  it('guarda a resposta por 10 minutos', async () => {
    const { fn, calls } = fakeFetch(okHandler);
    let now = NOW;
    const client = vercelClient({ token: 't', fetch: fn, now: () => now });
    await client.visitors('portfolio');
    await client.visitors('portfolio');
    assert.equal(calls.length, 3);
    now += 11 * 60_000;
    await client.visitors('portfolio');
    assert.equal(calls.length, 6);
  });

  it('plano sem histórico mensal (Hobby) não é erro', async () => {
    const { fn } = fakeFetch((url) =>
      url.searchParams.get('by') === 'month'
        ? { status: 400, body: { error: 'out of range' } }
        : okHandler(url),
    );
    const r = await vercelClient({ token: 't', fetch: fn, now: () => NOW }).visitors('portfolio');
    assert.ok('days' in r && r.error === null);
    assert.equal(r.monthsLimited, true);
    assert.deepEqual(r.months, []);
  });

  it('erros viram mensagem amigável, sem repetir a resposta da Vercel', async () => {
    const cases: [number, RegExp][] = [
      [403, /não tem acesso/],
      [404, /não encontrado/],
      [429, /Limite/],
      [500, /não respondeu/],
    ];
    for (const [status, msg] of cases) {
      const { fn } = fakeFetch(() => ({ status, body: { error: { message: 'detalhe interno xyz' } } }));
      const r = await vercelClient({ token: 't', fetch: fn, now: () => NOW }).visitors('portfolio');
      assert.ok('error' in r && typeof r.error === 'string');
      assert.match(r.error, msg);
      assert.doesNotMatch(JSON.stringify(r), /xyz/);
    }
    const offline = (async () => {
      throw new Error('ECONNREFUSED 10.0.0.1');
    }) as typeof fetch;
    const r = await vercelClient({ token: 't', fetch: offline, now: () => NOW }).visitors('portfolio');
    assert.ok('error' in r && r.error);
    assert.doesNotMatch(JSON.stringify(r), /10\.0\.0\.1/);
  });
});

describe('rota de visitantes', () => {
  async function appWith(fetchFn?: typeof fetch) {
    const db = openDb(':memory:');
    const app = await buildApp({
      db,
      authSecret: 'segredo-de-teste-com-tamanho-ok',
      runNow: async () => {},
      vercel: fetchFn ? vercelClient({ token: 'segredo-vercel', fetch: fetchFn, now: () => NOW }) : undefined,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { email: 'admin@exemplo.com', password: 'senha-forte-123' },
    });
    const c = res.cookies.find((x) => x.name === 'uivo_session');
    assert.ok(c);
    return { app, cookie: `${c.name}=${c.value}` };
  }

  it('exige login', async () => {
    const { app } = await appWith();
    assert.equal((await app.inject('/api/sites/1/visitors')).statusCode, 401);
  });

  it('salva o projeto, recusa formato inválido e nunca devolve o token', async () => {
    const { fn } = fakeFetch(okHandler);
    const { app, cookie } = await appWith(fn);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie },
      payload: { name: 'Loja', url: 'https://loja.com.br', vercel_project: 'x?teamId=outro' },
    });
    assert.equal(bad.statusCode, 400);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie },
      payload: { name: 'Loja', url: 'https://loja.com.br', vercel_project: 'meu-time/loja' },
    });
    assert.equal(created.statusCode, 201);
    const site = created.json();
    assert.equal(site.vercel_project, 'meu-time/loja');

    const res = await app.inject({ url: `/api/sites/${site.id}/visitors`, headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().thisMonth.visitors, 321);
    assert.doesNotMatch(res.body, /segredo-vercel/);

    const off = await app.inject({
      method: 'PATCH',
      url: `/api/sites/${site.id}`,
      headers: { cookie },
      payload: { vercel_project: '' },
    });
    assert.equal(off.json().vercel_project, null);
    const none = await app.inject({ url: `/api/sites/${site.id}/visitors`, headers: { cookie } });
    assert.deepEqual(none.json(), { configured: false, reason: 'project' });
  });

  it('sem token configurado, avisa', async () => {
    const { app, cookie } = await appWith();
    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie },
      payload: { name: 'Loja', url: 'https://loja.com.br', vercel_project: 'loja' },
    });
    const res = await app.inject({ url: `/api/sites/${created.json().id}/visitors`, headers: { cookie } });
    assert.deepEqual(res.json(), { configured: false, reason: 'token' });
  });
});
