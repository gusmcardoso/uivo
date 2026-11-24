import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, it } from 'node:test';
import { buildApp } from '../src/server/app.ts';
import type { HttpResult } from '../src/server/checks/http.ts';
import { getSite, openDb } from '../src/server/db.ts';
import { runExpiryChecks, runSiteCheck } from '../src/server/monitor.ts';
import { DAY } from '../src/server/util.ts';

const OK: HttpResult = { ok: true, statusCode: 200, responseMs: 120, error: null };
const FAIL: HttpResult = { ok: false, statusCode: 503, responseMs: 80, error: 'HTTP 503' };

let db: DatabaseSync;
let clock: number;

const addSite = (name = 'Loja') =>
  Number(
    db.prepare("INSERT INTO sites (name, url, created_at) VALUES (?, 'https://loja.com.br', 0)").run(name)
      .lastInsertRowid,
  );
async function check(id: number, result: HttpResult) {
  clock += 60_000;
  const site = getSite(db, id);
  assert.ok(site);
  await runSiteCheck(site, { db, notify: async () => {}, http: async () => result, now: () => clock });
}
const kinds = () =>
  db.prepare('SELECT kind, level, title FROM notifications ORDER BY id').all() as {
    kind: string;
    level: string;
    title: string;
  }[];

beforeEach(() => {
  db = openDb(':memory:');
  clock = Date.now();
});

describe('avisos do painel gerados pelo monitor', () => {
  it('instabilidade na 1ª falha, queda confirmada na 2ª e volta ao ar', async () => {
    const id = addSite();
    await check(id, OK);
    assert.equal(kinds().length, 0, 'site no ar não gera aviso');
    await check(id, FAIL);
    await check(id, FAIL);
    await check(id, FAIL); // continua fora: não repete o aviso
    await check(id, OK);
    assert.deepEqual(
      kinds().map((k) => [k.kind, k.level]),
      [
        ['unstable', 'warn'],
        ['down', 'bad'],
        ['up', 'good'],
      ],
    );
    assert.match(kinds()[1].title, /Loja está fora do ar/);
  });

  it('falha isolada vira só "instável" (sem queda)', async () => {
    const id = addSite();
    await check(id, OK);
    await check(id, FAIL);
    await check(id, OK);
    assert.deepEqual(
      kinds().map((k) => k.kind),
      ['unstable'],
    );
  });

  it('vencimento de SSL avisa uma vez por limite', async () => {
    const id = addSite();
    const site = getSite(db, id);
    assert.ok(site);
    const deps = {
      db,
      notify: async () => {},
      now: () => clock,
      ssl: async () => ({ valid: true, expiresAt: clock + 2 * DAY, issuer: 'Teste', error: null }),
      domain: async () => ({ domain: 'loja.com.br', expiresAt: null, error: null }),
    };
    await runExpiryChecks({ ...site, check_domain: 0 }, deps);
    await runExpiryChecks({ ...site, check_domain: 0, ssl_checked_at: null }, deps);
    const exp = kinds().filter((k) => k.kind === 'expiry');
    assert.equal(exp.length, 1);
    assert.equal(exp[0].level, 'bad');
    assert.match(exp[0].title, /Certificado SSL de Loja vence em 2 dia/);
  });

  it('avisos somem junto com o site e os de mais de 90 dias são apagados', async () => {
    const id = addSite();
    db.prepare(
      "INSERT INTO notifications (site_id, at, kind, level, title) VALUES (?, ?, 'up', 'good', 'antigo')",
    ).run(id, clock - 91 * DAY);
    await check(id, FAIL);
    assert.deepEqual(
      kinds().map((k) => k.kind),
      ['unstable'],
      'o antigo foi apagado',
    );
    db.prepare('DELETE FROM sites WHERE id = ?').run(id);
    assert.equal(kinds().length, 0);
  });
});

describe('API dos avisos e do cliente', () => {
  async function setup() {
    const app = await buildApp({ db, authSecret: 'segredo-de-teste-com-tamanho-ok', runNow: async () => {} });
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { email: 'admin@exemplo.com', password: 'senha-forte-123' },
    });
    const c = res.cookies.find((x) => x.name === 'uivo_session');
    return { app, cookie: `${c?.name}=${c?.value}` };
  }

  it('lista, entrega só os novos com "after" e marca como lidos', async () => {
    const { app, cookie } = await setup();
    assert.equal((await app.inject('/api/notifications')).statusCode, 401);
    const id = addSite();
    await check(id, OK);
    await check(id, FAIL);
    await check(id, FAIL);
    const all = (await app.inject({ url: '/api/notifications', headers: { cookie } })).json();
    assert.equal(all.items.length, 2);
    assert.equal(all.items[0].kind, 'down', 'mais recente primeiro');
    assert.equal(all.items[0].site_name, 'Loja');
    assert.equal(all.unread, 2);
    const first = all.items[1].id;
    const newer = (
      await app.inject({ url: `/api/notifications?after=${first}`, headers: { cookie } })
    ).json();
    assert.deepEqual(
      newer.items.map((n: { kind: string }) => n.kind),
      ['down'],
    );
    const read = await app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      headers: { cookie },
      payload: { upTo: first },
    });
    assert.equal(read.json().unread, 1);
    // não volta para trás nem passa do último
    await app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      headers: { cookie },
      payload: { upTo: 0 },
    });
    assert.equal((await app.inject({ url: '/api/notifications', headers: { cookie } })).json().unread, 1);
    await app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      headers: { cookie },
      payload: { upTo: 999999 },
    });
    assert.equal((await app.inject({ url: '/api/notifications', headers: { cookie } })).json().unread, 0);
    await check(id, OK);
    assert.equal(
      (await app.inject({ url: '/api/notifications', headers: { cookie } })).json().unread,
      1,
      'aviso novo depois de ler tudo',
    );
    const bad = await app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      headers: { cookie },
      payload: { upTo: 'x' },
    });
    assert.equal(bad.statusCode, 400);
  });

  it('cliente: salva limpo, vazio tira do grupo, tamanho limitado', async () => {
    const { app, cookie } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie },
      payload: { name: 'Loja', url: 'https://loja.com.br', client: '  Padaria   do  João ' },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().client, 'Padaria do João');
    const id = created.json().id;
    const patch = (client: unknown) =>
      app.inject({ method: 'PATCH', url: `/api/sites/${id}`, headers: { cookie }, payload: { client } });
    assert.equal((await patch('')).json().client, null);
    assert.equal((await patch('Clínica')).json().client, 'Clínica');
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/sites/${id}`,
          headers: { cookie },
          payload: { name: 'Loja 2' },
        })
      ).json().client,
      'Clínica',
      'sem o campo, mantém',
    );
    assert.equal((await patch('x'.repeat(61))).statusCode, 400);
  });
});
