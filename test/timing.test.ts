import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createGzip, gzipSync } from 'node:zlib';
import { checkHttp } from '../src/server/checks/http.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('tempo por etapa', () => {
  let server: Server;
  let base: string;

  let bomb: Buffer;

  before(async () => {
    bomb = await new Promise<Buffer>((resolve) => {
      const gz = createGzip({ level: 9 });
      const parts: Buffer[] = [];
      gz.on('data', (c: Buffer) => parts.push(c));
      gz.on('end', () => resolve(Buffer.concat(parts)));
      const zeros = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < 1024; i++) gz.write(zeros);
      gz.end();
    });
    server = createServer(async (req, res) => {
      switch (req.url) {
        case '/lento-servidor': // demora para começar a responder (processamento)
          await sleep(200);
          return res.end('ok');
        case '/lento-download': // responde rápido, mas o corpo chega devagar
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.write('a'.repeat(1000));
          await sleep(200);
          return res.end('b'.repeat(1000));
        case '/gzip':
          res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
          return res.end(gzipSync('<h1>Bem-vindo à Loja</h1>'));
        case '/r1':
          await sleep(100);
          res.writeHead(302, { location: '/r2' });
          return res.end();
        case '/r2':
          res.writeHead(301, { location: '/gzip' });
          return res.end();
        case '/loop':
          res.writeHead(302, { location: '/loop' });
          return res.end();
        case '/grande': {
          // 8 MB em pedaços: o monitor deve parar em 5 MB sem travar
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          const chunk = Buffer.alloc(256 * 1024, 1);
          for (let i = 0; i < 32 && !res.destroyed; i++) {
            if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
          }
          return res.end();
        }
        case '/bomba':
          // 1 GB de zeros comprimido em ~1 MB: descomprimir tudo derrubaria o monitor
          res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
          return res.end(bomb);
        case '/redireciona-lento': // cada salto é rápido, mas a soma estoura o limite
          await sleep(150);
          res.writeHead(302, { location: '/redireciona-lento' });
          return res.end();
        default:
          res.statusCode = 404;
          res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it('servidor lento aparece na espera, não no download', async () => {
    const r = await checkHttp(`${base}/lento-servidor`);
    assert.equal(r.ok, true);
    assert.ok(r.timings);
    assert.ok(r.timings.wait >= 180, `espera ${r.timings.wait}`);
    assert.ok(r.timings.download < 100, `download ${r.timings.download}`);
    assert.ok(r.responseMs >= 180);
  });

  it('corpo lento aparece no download, não na espera', async () => {
    const r = await checkHttp(`${base}/lento-download`);
    assert.ok(r.timings);
    assert.ok(r.timings.download >= 180, `download ${r.timings.download}`);
    assert.ok(r.timings.wait < 100, `espera ${r.timings.wait}`);
    assert.equal(r.bytes, 2000);
    assert.ok(r.timings.total >= r.timings.wait + r.timings.download);
  });

  it('endereço IP não tem etapa de DNS; HTTP não tem TLS', async () => {
    const r = await checkHttp(`${base}/lento-servidor`);
    assert.equal(r.timings?.dns, 0);
    assert.equal(r.timings?.tls, 0);
  });

  it('descomprime gzip para achar a palavra-chave e registra a compressão', async () => {
    const r = await checkHttp(`${base}/gzip`, { keyword: 'Loja' });
    assert.equal(r.ok, true);
    assert.equal(r.encoding, 'gzip');
    assert.ok((r.bytes ?? 0) > 0);
  });

  it('conta redirecionamentos, mede o tempo gasto neles e informa a URL final', async () => {
    const r = await checkHttp(`${base}/r1`);
    assert.equal(r.ok, true);
    assert.equal(r.redirects, 2);
    assert.equal(r.finalUrl, `${base}/gzip`);
    assert.ok((r.timings?.redirect ?? 0) >= 90, `redirect ${r.timings?.redirect}`);
  });

  it('loop de redirecionamento vira erro legível', async () => {
    const r = await checkHttp(`${base}/loop`);
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /Redirecionamentos demais/);
    assert.equal(r.redirects, 5);
  });

  it('para de baixar em 5 MB sem travar', async () => {
    const r = await checkHttp(`${base}/grande`);
    assert.equal(r.ok, true);
    assert.ok((r.bytes ?? 0) >= 5 * 1024 * 1024 && (r.bytes ?? 0) < 6 * 1024 * 1024, `bytes ${r.bytes}`);
  });

  it('bomba de compressão não derruba o monitor', async () => {
    const before = process.memoryUsage().rss;
    const r = await checkHttp(`${base}/bomba`, { keyword: 'Loja' });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /Palavra-chave/);
    assert.ok(process.memoryUsage().rss - before < 300 * 1024 * 1024, 'uso de memória explodiu');
  });

  it('o tempo limite vale para a requisição inteira, não por salto', async () => {
    const t = performance.now();
    const r = await checkHttp(`${base}/redireciona-lento`, { timeoutMs: 400 });
    assert.equal(r.ok, false);
    assert.ok(
      r.error === 'Tempo de resposta esgotado' || /Redirecionamentos demais/.test(r.error ?? ''),
      r.error ?? '',
    );
    assert.ok(performance.now() - t < 1_000);
  });
});

describe('percentis', () => {
  it('posto mais próximo, com listas pequenas e vazias', async () => {
    const { percentile } = await import('../src/server/app.ts');
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    assert.equal(percentile(values, 50), 50);
    assert.equal(percentile(values, 95), 95);
    assert.equal(percentile(values, 99), 99);
    assert.equal(percentile([42], 95), 42);
    assert.equal(percentile([], 50), null);
  });
});
