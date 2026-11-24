import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { buildApp } from '../src/server/app.ts';
import { openDb } from '../src/server/db.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('detalhe de um ponto do gráfico (/moment)', () => {
  const db = openDb(':memory:');
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie = '';
  const at = Date.UTC(2026, 10, 20, 15); // 20/11, 15h UTC
  let id = 0;

  before(async () => {
    app = await buildApp({ db, authSecret: 'segredo-de-teste-com-tamanho-ok', runNow: async () => {} });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { email: 'admin@exemplo.com', password: 'senha-forte-123' },
    });
    const c = setup.cookies.find((x) => x.name === 'uivo_session');
    cookie = `${c?.name}=${c?.value}`;
    id = Number(
      db.prepare("INSERT INTO sites (name, url, created_at) VALUES ('Loja', 'https://loja.com.br', 0)").run()
        .lastInsertRowid,
    );
    const ins = db.prepare('INSERT INTO checks (site_id, at, ok, response_ms) VALUES (?, ?, ?, ?)');
    // agora: 300 e 500 ms + uma falha; ontem: 200 ms; há 7 dias: 100 ms; dias 2 a 6: 150 ms
    ins.run(id, at + 1000, 1, 300);
    ins.run(id, at + 2000, 1, 500);
    ins.run(id, at + 3000, 0, 9999);
    ins.run(id, at - DAY + 1000, 1, 200);
    ins.run(id, at - 7 * DAY + 1000, 1, 100);
    for (let d = 2; d <= 6; d++) ins.run(id, at - d * DAY + 1000, 1, 150);
    // fora da janela (não pode contar)
    ins.run(id, at + HOUR + 1, 1, 5000);
    db.prepare('INSERT INTO incidents (site_id, started_at, ended_at, reason) VALUES (?, ?, ?, ?)').run(
      id,
      at + 2500,
      at + 4000,
      'HTTP 503',
    );
  });

  const get = (q: string) => app.inject({ url: `/api/sites/${id}/moment?${q}`, headers: { cookie } });

  it('resume o intervalo e compara com ontem, semana passada e o normal do horário', async () => {
    const r = (await get(`at=${at}&span=${HOUR}`)).json();
    assert.deepEqual(r.current, { n: 3, fails: 1, avg: 400, min: 300, max: 500 }); // falha fora da média
    assert.equal(r.yesterday.avg, 200);
    assert.equal(r.lastWeek.avg, 100);
    // média dos 7 dias anteriores: (200 + 150×5 + 100) / 7 = 150
    assert.deepEqual(r.typical, { avg: 150, days: 7 });
    assert.equal(r.incidents.length, 1);
    assert.equal(r.incidents[0].reason, 'HTTP 503');
  });

  it('intervalo sem checagens devolve vazio (sem inventar número)', async () => {
    const r = (await get(`at=${at - 30 * DAY}&span=${HOUR}`)).json();
    assert.deepEqual(r.current, { n: 0, fails: 0, avg: null, min: null, max: null });
    assert.deepEqual(r.typical, { avg: null, days: 0 });
  });

  it('valida os parâmetros e exige login', async () => {
    assert.equal((await get('at=abc&span=3600000')).statusCode, 400);
    assert.equal((await get(`at=${at}&span=10`)).statusCode, 400);
    assert.equal((await get(`at=${at}&span=${2 * DAY}`)).statusCode, 400);
    assert.equal((await app.inject(`/api/sites/${id}/moment?at=${at}&span=${HOUR}`)).statusCode, 401);
    assert.equal(
      (await app.inject({ url: `/api/sites/999/moment?at=${at}&span=${HOUR}`, headers: { cookie } }))
        .statusCode,
      404,
    );
  });
});
