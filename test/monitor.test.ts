import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, it } from 'node:test';
import type { HttpResult } from '../src/server/checks/http.ts';
import { getSite, openDb } from '../src/server/db.ts';
import { runExpiryChecks, runSiteCheck } from '../src/server/monitor.ts';
import { DAY, HOUR } from '../src/server/util.ts';

const OK: HttpResult = { ok: true, statusCode: 200, responseMs: 120, error: null };
const FAIL: HttpResult = { ok: false, statusCode: 503, responseMs: 80, error: 'HTTP 503' };

let db: DatabaseSync;
let alerts: string[];
let clock: number;

function addSite(url = 'https://exemplo.com.br'): number {
  return Number(
    db.prepare('INSERT INTO sites (name, url, created_at) VALUES (?, ?, ?)').run('Exemplo', url, Date.now())
      .lastInsertRowid,
  );
}

async function check(id: number, result: HttpResult) {
  clock += 60_000;
  const site = getSite(db, id);
  assert.ok(site);
  await runSiteCheck(site, {
    db,
    notify: async (t) => void alerts.push(t),
    http: async () => result,
    now: () => clock,
  });
  return getSite(db, id);
}

beforeEach(() => {
  db = openDb(':memory:');
  alerts = [];
  clock = Date.now();
});

describe('confirmação de queda', () => {
  it('uma falha isolada não derruba o site nem alerta', async () => {
    const id = addSite();
    await check(id, OK);
    const site = await check(id, FAIL);
    assert.equal(site?.status, 'up');
    assert.equal(site?.fail_streak, 1);
    assert.equal(alerts.length, 0);
  });

  it('duas falhas seguidas abrem incidente e alertam uma única vez', async () => {
    const id = addSite();
    await check(id, FAIL);
    await check(id, FAIL);
    const site = await check(id, FAIL);
    assert.equal(site?.status, 'down');
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /fora do ar/);
    const open = db.prepare('SELECT COUNT(*) AS n FROM incidents WHERE ended_at IS NULL').get() as {
      n: number;
    };
    assert.equal(open.n, 1);
  });

  it('a volta fecha o incidente e avisa a duração', async () => {
    const id = addSite();
    await check(id, FAIL);
    await check(id, FAIL);
    const site = await check(id, OK);
    assert.equal(site?.status, 'up');
    assert.equal(site?.fail_streak, 0);
    assert.equal(alerts.length, 2);
    assert.match(alerts[1], /voltou ao ar/);
    assert.match(alerts[1], /Ficou fora por 1 min/);
    const inc = db.prepare('SELECT ended_at FROM incidents').get() as { ended_at: number | null };
    assert.ok(inc.ended_at);
  });

  it('grava cada checagem no histórico', async () => {
    const id = addSite();
    await check(id, OK);
    await check(id, FAIL);
    const n = db.prepare('SELECT COUNT(*) AS n FROM checks WHERE site_id = ?').get(id) as { n: number };
    assert.equal(n.n, 2);
  });
});

describe('avisos de vencimento', () => {
  async function expiry(id: number, sslDays: number, domainDays: number) {
    const site = getSite(db, id);
    assert.ok(site);
    await runExpiryChecks(site, {
      db,
      notify: async (t) => void alerts.push(t),
      now: () => clock,
      ssl: async () => ({
        expiresAt: clock + sslDays * DAY + HOUR,
        issuer: "Let's Encrypt",
        valid: true,
        error: null,
      }),
      domain: async () => ({
        domain: 'exemplo.com.br',
        expiresAt: clock + domainDays * DAY + HOUR,
        error: null,
      }),
    });
  }

  it('avisa SSL a 14 dias e domínio a 30 dias, sem repetir', async () => {
    const id = addSite();
    await expiry(id, 10, 20);
    assert.equal(alerts.length, 2);
    assert.match(alerts[0], /Certificado SSL .* vence em 10 dia/);
    assert.match(alerts[1], /Domínio .* vence em 20 dia/);

    clock += DAY + HOUR; // próximo ciclo: mesmas faixas, nenhum aviso novo
    await expiry(id, 9, 19);
    assert.equal(alerts.length, 2);
  });

  it('avisa de novo ao cruzar a faixa seguinte (3 dias)', async () => {
    const id = addSite();
    await expiry(id, 10, 90);
    clock += DAY + HOUR;
    await expiry(id, 2, 90);
    assert.equal(alerts.length, 2);
    assert.match(alerts[1], /vence em 2 dia/);
  });

  it('renovação libera os avisos para o próximo vencimento', async () => {
    const id = addSite();
    await expiry(id, 10, 90);
    clock += DAY + HOUR;
    await expiry(id, 80, 90); // renovado
    clock += DAY + HOUR;
    await expiry(id, 12, 90);
    assert.equal(alerts.length, 2);
  });

  it('não checa SSL em site sem HTTPS', async () => {
    const id = addSite('http://exemplo.com.br');
    await expiry(id, 1, 90);
    assert.equal(alerts.length, 0);
    assert.equal(getSite(db, id)?.ssl_checked_at, null);
  });
});
