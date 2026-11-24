import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { buildApp } from '../src/server/app.ts';
import { openDb } from '../src/server/db.ts';
import { buildReport, monthRange } from '../src/server/report/data.ts';
import { formatDuration, periodLabel, plainReason, renderReport } from '../src/server/report/pdf.ts';

process.env.TZ = 'America/Sao_Paulo';
const HOUR = 3_600_000;

let db: ReturnType<typeof openDb>;
const { from, to } = monthRange(2026, 11);

/** Site com checagem de hora em hora no mês inteiro, com uma janela de falha opcional. */
function seedSite(name: string, opts: { failFrom?: number; failTo?: number; skipDays?: number } = {}) {
  const id = Number(
    db
      .prepare('INSERT INTO sites (name, url, interval_sec, created_at) VALUES (?, ?, 3600, ?)')
      .run(name, `https://${name.toLowerCase()}.com.br`, from - 30 * 24 * HOUR).lastInsertRowid,
  );
  const insert = db.prepare('INSERT INTO checks (site_id, at, ok, response_ms) VALUES (?, ?, ?, ?)');
  const start = from + (opts.skipDays ?? 0) * 24 * HOUR;
  for (let t = start; t < to; t += HOUR) {
    const failing = opts.failFrom !== undefined && t >= opts.failFrom && t < (opts.failTo ?? 0);
    insert.run(id, t, failing ? 0 : 1, 100 + ((t / HOUR) % 10) * 10);
  }
  return id;
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('período do relatório', () => {
  it('mês começa à meia-noite de São Paulo e termina no início do mês seguinte', () => {
    assert.equal(new Date(from).toISOString(), '2026-11-01T03:00:00.000Z');
    assert.equal(new Date(to).toISOString(), '2026-12-01T03:00:00.000Z');
    assert.equal(periodLabel(from), 'Novembro de 2026');
  });

  it('traduz o motivo técnico da queda para quem não é da área', () => {
    assert.match(plainReason('HTTP 503'), /erro interno \(código 503\)/);
    assert.match(plainReason('HTTP 404'), /não foi encontrada/);
    assert.match(plainReason('Tempo de resposta esgotado'), /demorou demais/);
    assert.match(plainReason('Domínio não encontrado (DNS)'), /não foi encontrado na internet/);
    assert.match(plainReason('Conexão recusada'), /recusou a conexão/);
    assert.match(plainReason('Palavra-chave "Loja" não encontrada'), /sem o conteúdo esperado/);
    assert.equal(plainReason(null), 'o site não respondeu');
    assert.equal(plainReason('erro raro XYZ'), 'erro raro XYZ');
  });

  it('formata durações em português', () => {
    assert.equal(formatDuration(0), '0 min');
    assert.equal(formatDuration(45 * 60_000), '45 min');
    assert.equal(formatDuration(2 * HOUR + 15 * 60_000), '2 h 15 min');
    assert.equal(formatDuration(26 * HOUR), '1 d 2 h');
  });
});

describe('dados do relatório', () => {
  it('uptime, quedas e tempo fora do ar exatos', () => {
    const day10 = from + 9 * 24 * HOUR + 10 * HOUR;
    const id = seedSite('Loja', { failFrom: day10, failTo: day10 + 2 * HOUR });
    db.prepare('INSERT INTO incidents (site_id, started_at, ended_at, reason) VALUES (?, ?, ?, ?)').run(
      id,
      day10,
      day10 + 2 * HOUR,
      'HTTP 503',
    );
    const r = buildReport(db, { year: 2026, month: 11, now: to + HOUR });
    const s = r.sites[0];
    assert.equal(s.checks, 720); // 30 dias × 24 h
    assert.equal(s.uptime, Math.round((718 / 720) * 10000) / 100);
    assert.equal(s.incidents.length, 1);
    assert.equal(s.downtimeMs, 2 * HOUR);
    assert.equal(s.coverage, 100);
    assert.equal(s.daily.length, 30);
    assert.equal(s.daily[9], (22 / 24) * 100);
    assert.equal(s.daily[0], 100);
  });

  it('queda que atravessa a virada do mês conta só a parte dentro do período', () => {
    const id = seedSite('Loja');
    db.prepare('INSERT INTO incidents (site_id, started_at, ended_at, reason) VALUES (?, ?, ?, ?)').run(
      id,
      from - 3 * HOUR,
      from + HOUR,
      'Tempo esgotado',
    );
    db.prepare('INSERT INTO incidents (site_id, started_at, ended_at, reason) VALUES (?, ?, ?, ?)').run(
      id,
      to - HOUR,
      to + 5 * HOUR,
      'Conexão recusada',
    );
    const s = buildReport(db, { year: 2026, month: 11, now: to + 10 * HOUR }).sites[0];
    assert.equal(s.incidents.length, 2);
    assert.equal(s.downtimeMs, 2 * HOUR); // 1 h no começo + 1 h no fim
  });

  it('queda em andamento conta até agora; mês em andamento não conta o futuro', () => {
    const id = seedSite('Loja');
    const now = from + 15 * 24 * HOUR;
    db.prepare('INSERT INTO incidents (site_id, started_at, ended_at, reason) VALUES (?, ?, NULL, ?)').run(
      id,
      now - 3 * HOUR,
      'HTTP 500',
    );
    const s = buildReport(db, { year: 2026, month: 11, now }).sites[0];
    assert.equal(s.downtimeMs, 3 * HOUR);
    assert.equal(s.incidents[0].end, null);
    assert.equal(s.checks, 15 * 24); // só até agora
  });

  it('monitoramento parcial aparece na cobertura (sem inflar o uptime)', () => {
    seedSite('Notebook', { skipDays: 12 }); // 12 dias sem checagem
    const s = buildReport(db, { year: 2026, month: 11, now: to + HOUR }).sites[0];
    assert.equal(s.uptime, 100);
    assert.equal(s.coverage, 60); // 18 de 30 dias
    assert.equal(s.daily[0], null);
    assert.equal(s.daily[12], 100);
  });

  it('filtra os sites escolhidos e usa título e autor', () => {
    seedSite('A');
    const b = seedSite('B');
    const r = buildReport(db, {
      year: 2026,
      month: 11,
      siteIds: [b],
      title: ' Loja do João ',
      author: 'Gustavo',
    });
    assert.deepEqual(
      r.sites.map((s) => s.name),
      ['B'],
    );
    assert.equal(r.title, 'Loja do João');
    assert.equal(r.author, 'Gustavo');
  });
});

describe('PDF', () => {
  it('gera um PDF válido com capa + uma página por site, sem páginas extras', async () => {
    seedSite('Loja');
    seedSite('Notebook', { skipDays: 12 });
    const data = buildReport(db, {
      year: 2026,
      month: 11,
      title: 'Relatório da Loja',
      author: 'Gustavo',
      now: to + HOUR,
    });
    const pdf = await renderReport(data, { compress: false });
    const text = pdf.toString('latin1');
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const pages = text.match(/\/Type \/Page\b/g)?.length ?? 0;
    // capa + 2 páginas por site + glossário (o rodapé não pode criar páginas)
    assert.equal(pages, 7, `páginas: ${pages}`); // capa + resumo + 2 por site + glossário
    // tamanho do arquivo real (comprimido, com a fonte embutida e os pixels da capa)
    const real = await renderReport(data);
    assert.ok(real.length < 250_000, `tamanho: ${real.length}`);
  });

  it('também gera com zero sites e com site sem nenhuma checagem', async () => {
    const empty = await renderReport(buildReport(db, { year: 2026, month: 11 }));
    assert.equal(empty.subarray(0, 5).toString(), '%PDF-');
    db.prepare("INSERT INTO sites (name, url, created_at) VALUES ('Novo', 'https://novo.com.br', 0)").run();
    const noData = await renderReport(buildReport(db, { year: 2026, month: 11 }));
    assert.equal(noData.subarray(0, 5).toString(), '%PDF-');
  });
});

describe('API do relatório', () => {
  it('exige login, valida o mês e devolve o PDF para download', async () => {
    const app = await buildApp({ db, authSecret: 'segredo-de-teste-com-tamanho-ok', runNow: async () => {} });
    seedSite('Loja');
    assert.equal((await app.inject('/api/reports/monthly?month=2026-11')).statusCode, 401);
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { email: 'admin@exemplo.com', password: 'senha-forte-123' },
    });
    const c = setup.cookies.find((x) => x.name === 'uivo_session');
    const cookie = `${c?.name}=${c?.value}`;
    for (const bad of ['2026-13', 'abc', '2026-1', '1999-01']) {
      assert.equal(
        (await app.inject({ url: `/api/reports/monthly?month=${bad}`, headers: { cookie } })).statusCode,
        400,
        bad,
      );
    }
    const res = await app.inject({
      url: '/api/reports/monthly?month=2026-11&title=Relat%C3%B3rio%20da%20Loja',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.match(
      String(res.headers['content-disposition']),
      /attachment; filename="relatorio-uivo-2026-11\.pdf"/,
    );
    assert.equal(res.rawPayload.subarray(0, 5).toString(), '%PDF-');
  });
});
