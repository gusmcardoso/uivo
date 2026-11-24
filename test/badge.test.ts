import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/server/app.ts';
import { renderBadge } from '../src/server/badge.ts';
import { openDb } from '../src/server/db.ts';

describe('selo "monitorado com uivo"', () => {
  it('só existe para sites públicos; privado e inexistente respondem igual (404)', async () => {
    const db = openDb(':memory:');
    const app = await buildApp({ db, authSecret: 'segredo-de-teste-com-tamanho-ok', runNow: async () => {} });
    const add = (name: string, isPublic: number, status: string) =>
      Number(
        db
          .prepare(
            "INSERT INTO sites (name, url, public, status, created_at) VALUES (?, 'https://x.com.br', ?, ?, 0)",
          )
          .run(name, isPublic, status).lastInsertRowid,
      );
    const pub = add('Loja <Pública>', 1, 'up');
    const priv = add('Painel interno', 0, 'up');
    const ins = db.prepare('INSERT INTO checks (site_id, at, ok, response_ms) VALUES (?, ?, ?, 100)');
    const now = Date.now();
    for (let i = 0; i < 99; i++) ins.run(pub, now - i * 60_000, 1);
    ins.run(pub, now - 100 * 60_000, 0); // 99 de 100 no ar

    const ok = await app.inject(`/badge/${pub}.svg`);
    assert.equal(ok.statusCode, 200);
    assert.match(String(ok.headers['content-type']), /^image\/svg\+xml/);
    assert.equal(ok.headers['cache-control'], 'public, max-age=300');
    assert.equal(ok.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.match(ok.body, /99,00% em 30 dias/);
    assert.match(ok.body, /Loja &lt;Pública&gt;/, 'nome escapado no título');
    assert.doesNotMatch(ok.body, /<Pública>/);
    assert.doesNotMatch(ok.body, /https:\/\/x\.com\.br/, 'não expõe o endereço monitorado');

    const privado = await app.inject(`/badge/${priv}.svg`);
    const inexistente = await app.inject('/badge/9999.svg');
    assert.equal(privado.statusCode, 404);
    assert.equal(inexistente.statusCode, 404);
    assert.equal(privado.body, inexistente.body);
    assert.equal((await app.inject('/badge/abc.svg')).statusCode, 404);
  });

  it('mostra "fora do ar" em vermelho e tem versão clara', () => {
    const down = renderBadge({ name: 'Loja', status: 'down', uptime: 97.5, theme: 'escuro' });
    assert.match(down, /fora do ar/);
    assert.match(down, /#ef4444/);
    const light = renderBadge({ name: 'Loja', status: 'up', uptime: 100, theme: 'claro' });
    assert.match(light, /fill="#ffffff"/);
    assert.match(light, /<animate /, 'ponto pulsa quando está no ar');
    assert.ok(light.startsWith('<svg') && light.endsWith('</svg>'));
  });
});
