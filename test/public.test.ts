import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, it } from 'node:test';
import { buildApp } from '../src/server/app.ts';
import { openDb } from '../src/server/db.ts';
import { STATUS_DAYS } from '../src/server/public.ts';

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let db: DatabaseSync;
const TOKEN = 'token-de-metricas-123';

function addSite(name: string, isPublic: boolean, status = 'up'): number {
  const now = Date.now();
  const id = Number(
    db
      .prepare(
        `INSERT INTO sites (name, url, public, status, ssl_expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(name, `https://${name.toLowerCase()}.com.br`, isPublic ? 1 : 0, status, now + 30 * 86_400_000, now)
      .lastInsertRowid,
  );
  const insert = db.prepare(
    'INSERT INTO checks (site_id, at, ok, status_code, response_ms) VALUES (?, ?, ?, 200, 150)',
  );
  insert.run(id, now - 1000, 1);
  insert.run(id, now - 2000, status === 'up' ? 1 : 0);
  return id;
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildApp({
    db,
    authSecret: 'segredo-de-teste-com-tamanho-ok',
    runNow: async () => {},
    metricsToken: TOKEN,
    statusTitle: 'Status de teste',
  });
});

describe('página de status pública', () => {
  it('não exige login e só mostra sites públicos', async () => {
    addSite('Loja', true);
    addSite('Interno', false);
    const res = await app.inject('/api/public/status');
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.title, 'Status de teste');
    assert.deepEqual(
      body.sites.map((s: { name: string }) => s.name),
      ['Loja'],
    );
  });

  it('traz 90 dias de histórico, com o dia de hoje preenchido', async () => {
    addSite('Loja', true);
    const site = (await app.inject('/api/public/status')).json().sites[0];
    assert.equal(site.history.length, STATUS_DAYS);
    assert.equal(site.history.at(-1), 100);
    assert.equal(site.history[0], null);
    assert.equal(site.host, 'loja.com.br');
  });

  it('não expõe a URL completa nem campos internos', async () => {
    addSite('Loja', true);
    const site = (await app.inject('/api/public/status')).json().sites[0];
    assert.equal(site.url, undefined);
    assert.equal(site.keyword, undefined);
  });
});

describe('/metrics', () => {
  it('exige o token', async () => {
    assert.equal((await app.inject('/metrics')).statusCode, 401);
    const wrong = await app.inject({ url: '/metrics', headers: { authorization: 'Bearer errado' } });
    assert.equal(wrong.statusCode, 401);
  });

  it('fica desligado sem METRICS_TOKEN', async () => {
    const off = await buildApp({ db, authSecret: 'segredo-de-teste-com-tamanho-ok', runNow: async () => {} });
    assert.equal((await off.inject('/metrics')).statusCode, 404);
  });

  it('exporta no formato Prometheus', async () => {
    addSite('Loja', true);
    addSite('Fora', false, 'down');
    const res = await app.inject({ url: '/metrics', headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/plain/);
    const text = res.body;
    assert.match(text, /# TYPE uivo_site_up gauge/);
    assert.match(text, /uivo_site_up\{site="Loja",url="https:\/\/loja.com.br"\} 1/);
    assert.match(text, /uivo_site_up\{site="Fora",url="https:\/\/fora.com.br"\} 0/);
    assert.match(text, /uivo_site_response_seconds\{site="Loja",[^}]*\} 0.15/);
    assert.match(text, /uivo_site_uptime_ratio\{site="Fora",[^}]*window="24h"\} 0.5/);
    assert.doesNotMatch(
      text,
      /uivo_site_response_seconds\{site="Fora"/,
      'site fora do ar não exporta tempo de resposta',
    );
    assert.match(text, /uivo_ssl_expiry_timestamp_seconds\{site="Loja"/);
  });
});

describe('migração', () => {
  it('banco da v0.1 ganha a coluna public', () => {
    const cols = (db.prepare('PRAGMA table_info(sites)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes('public'));
  });
});
