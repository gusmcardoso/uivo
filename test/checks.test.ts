import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { checkDomain, parseRdapExpiration, registrableDomain } from '../src/server/checks/domain.ts';
import { checkHttp } from '../src/server/checks/http.ts';
import { checkSsl } from '../src/server/checks/ssl.ts';

describe('checagem HTTP', () => {
  let server: Server;
  let base: string;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ok') return res.end('<h1>Bem-vindo à loja</h1>');
      if (req.url === '/erro') {
        res.statusCode = 500;
        return res.end('erro');
      }
      if (req.url === '/redireciona') {
        res.writeHead(301, { location: '/ok' });
        return res.end();
      }
      if (req.url === '/lento') return setTimeout(() => res.end('tarde'), 2_000);
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it('200 é sucesso e mede o tempo', async () => {
    const r = await checkHttp(`${base}/ok`);
    assert.equal(r.ok, true);
    assert.equal(r.statusCode, 200);
    assert.ok(r.responseMs >= 0);
  });

  it('500 é falha', async () => {
    const r = await checkHttp(`${base}/erro`);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'HTTP 500');
  });

  it('segue redirecionamento', async () => {
    assert.equal((await checkHttp(`${base}/redireciona`)).ok, true);
  });

  it('palavra-chave presente passa; ausente falha mesmo com 200', async () => {
    assert.equal((await checkHttp(`${base}/ok`, { keyword: 'loja' })).ok, true);
    const r = await checkHttp(`${base}/ok`, { keyword: 'carrinho' });
    assert.equal(r.ok, false);
    assert.equal(r.statusCode, 200);
    assert.match(r.error ?? '', /carrinho/);
  });

  it('tempo esgotado vira falha legível', async () => {
    const r = await checkHttp(`${base}/lento`, { timeoutMs: 200 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Tempo de resposta esgotado');
  });

  it('conexão recusada vira falha legível', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const r = await checkHttp(`http://127.0.0.1:${port}/`);
    assert.equal(r.ok, false);
    // Windows/CI: recusada; WSL aceita e derruba a conexão. Em ambos, mensagem legível (não código cru).
    assert.match(r.error ?? '', /^Conexão (recusada|encerrada pelo servidor|interrompida)$/);
  });
});

describe('domínio', () => {
  it('extrai o domínio registrável', () => {
    assert.equal(registrableDomain('www.loja.com.br'), 'loja.com.br');
    assert.equal(registrableDomain('app.painel.exemplo.com'), 'exemplo.com');
    assert.equal(registrableDomain('exemplo.dev.br'), 'exemplo.dev.br');
    assert.equal(registrableDomain('localhost'), null);
    assert.equal(registrableDomain('192.168.0.10'), null);
  });

  it('lê a data de vencimento do RDAP', () => {
    const json = {
      events: [
        { eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' },
        { eventAction: 'expiration', eventDate: '2027-03-15T00:00:00Z' },
      ],
    };
    assert.equal(parseRdapExpiration(json), Date.parse('2027-03-15T00:00:00Z'));
    assert.equal(parseRdapExpiration({}), null);
  });

  it('.br consulta o Registro.br; plataformas não são consultadas', async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      return Response.json({ events: [{ eventAction: 'expiration', eventDate: '2027-01-01T00:00:00Z' }] });
    }) as unknown as typeof fetch;
    const br = await checkDomain('https://www.loja.com.br/contato', fakeFetch);
    assert.equal(br.domain, 'loja.com.br');
    assert.ok(br.expiresAt);
    assert.equal(urls[0], 'https://rdap.registro.br/domain/loja.com.br'); // .br não consulta a IANA

    const vercel = await checkDomain('https://meusite.vercel.app', fakeFetch);
    assert.equal(vercel.expiresAt, null);
    assert.equal(urls.length, 1);
  });
});

describe('SSL', () => {
  it('site sem HTTPS é reportado sem conexão', async () => {
    const r = await checkSsl('http://exemplo.com');
    assert.equal(r.valid, false);
    assert.equal(r.error, 'Site sem HTTPS');
  });
});

describe('RDAP pela lista da IANA', () => {
  it('.com consulta o servidor oficial da extensão', async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      if (url.includes('iana.org')) {
        return Response.json({ services: [[['com', 'net'], ['https://rdap.verisign.com/com/v1/']]] });
      }
      return Response.json({ events: [{ eventAction: 'expiration', eventDate: '2028-05-01T00:00:00Z' }] });
    }) as unknown as typeof fetch;
    const r = await checkDomain('https://www.exemplo.com', fakeFetch);
    assert.equal(r.expiresAt, Date.parse('2028-05-01T00:00:00Z'));
    assert.equal(urls.at(-1), 'https://rdap.verisign.com/com/v1/domain/exemplo.com');
  });
});
