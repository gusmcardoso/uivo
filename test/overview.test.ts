import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/server/app.ts';
import { openDb } from '../src/server/db.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('visão geral da tela inicial (/api/overview)', () => {
  it('24 faixas de 1 h por site, variação da resposta contra ontem e quedas do dia', async () => {
    const db = openDb(':memory:');
    const app = await buildApp({ db, authSecret: 'segredo-de-teste-com-tamanho-ok', runNow: async () => {} });
    assert.equal((await app.inject('/api/overview')).statusCode, 401);
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { email: 'admin@exemplo.com', password: 'senha-forte-123' },
    });
    const c = setup.cookies.find((x) => x.name === 'uivo_session');
    const cookie = `${c?.name}=${c?.value}`;

    const id = Number(
      db.prepare("INSERT INTO sites (name, url, created_at) VALUES ('Loja', 'https://loja.com.br', 0)").run()
        .lastInsertRowid,
    );
    const now = Date.now();
    const ins = db.prepare('INSERT INTO checks (site_id, at, ok, response_ms) VALUES (?, ?, ?, ?)');
    // hoje: 200 ms; uma falha há 2 h; ontem: 250 ms
    for (let t = now - DAY + 60_000; t < now; t += 10 * 60_000) ins.run(id, t, 1, 200);
    ins.run(id, now - 2 * HOUR, 0, 9999);
    for (let t = now - 2 * DAY + 60_000; t < now - DAY; t += 10 * 60_000) ins.run(id, t, 1, 250);
    db.prepare('INSERT INTO incidents (site_id, started_at, ended_at, reason) VALUES (?, ?, ?, ?)').run(
      id,
      now - 2 * HOUR,
      now - 2 * HOUR + 600_000,
      'HTTP 503',
    );
    db.prepare("INSERT INTO sites (name, url, created_at) VALUES ('Novo', 'https://novo.com.br', 0)").run();

    const r = (await app.inject({ url: '/api/overview', headers: { cookie } })).json();
    const loja = r.sites.find((s: { id: number }) => s.id === id);
    assert.equal(loja.hours.length, 24);
    assert.equal(loja.responseMs, 200, 'a falha não entra na média');
    assert.equal(loja.responseChange, -20); // 200 contra 250
    assert.equal(loja.incidents24h, 1);
    assert.ok(
      loja.hours.some((h: { uptime: number } | null) => h !== null && h.uptime < 100),
      'hora com falha',
    );
    assert.equal(r.incidents24h, 1);
    const novo = r.sites.find((s: { id: number }) => s.id !== id);
    assert.deepEqual(novo.hours, Array(24).fill(null));
    assert.equal(novo.responseChange, null);
  });
});
