import PDFDocument from 'pdfkit';
import { BRAND } from '../../shared/brand.ts';
import type { Severity } from '../checks/security.ts';
import type { ReportData, ReportSite } from './data.ts';

const C = {
  brand: '#059669',
  brandLight: '#d1fae5',
  text: '#18181b',
  muted: '#71717a',
  line: '#e4e4e7',
  soft: '#f4f4f5',
  red: '#dc2626',
  amber: '#d97706',
  empty: '#e4e4e7',
};
const SEVERITY: Record<Severity, { label: string; color: string }> = {
  critical: { label: 'Crítico', color: C.red },
  high: { label: 'Alto', color: '#ea580c' },
  medium: { label: 'Médio', color: C.amber },
  low: { label: 'Baixo', color: C.muted },
};
const M = 48; // margem

export function formatDuration(ms: number): string {
  if (ms <= 0) return '0 min';
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(v === 100 ? 0 : 2).replace('.', ',')}%`);
const dateTime = (ts: number) =>
  new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const days = (d: number | null) => (d === null ? '—' : d < 0 ? 'vencido' : `${d} dias`);
const scoreColor = (s: number | null) =>
  s === null ? C.muted : s >= 90 ? C.brand : s >= 70 ? C.amber : C.red;
const uptimeColor = (u: number | null) =>
  u === null ? C.empty : u >= 99.5 ? C.brand : u >= 95 ? C.amber : C.red;

export function periodLabel(from: number): string {
  const s = new Date(from).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Doc = InstanceType<typeof PDFDocument>;

function logo(doc: Doc, x: number, y: number) {
  // marca do Uivo (versão para fundo claro), em vetor, com os mesmos traços do painel
  const scale = 34 / BRAND.height;
  doc.save().translate(x, y).scale(scale);
  doc.path(BRAND.wordmark).fillColor(C.text).fill();
  BRAND.arcs.forEach((d, i) => {
    doc
      .path(d)
      .lineWidth(2.2)
      .lineCap('round')
      .strokeOpacity(BRAND.arcOpacity[i])
      .strokeColor(BRAND.ice.onLight)
      .stroke();
  });
  doc.restore();
}

function card(doc: Doc, x: number, y: number, w: number, label: string, value: string, color = C.text) {
  doc.roundedRect(x, y, w, 54, 6).fill(C.soft);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(C.muted)
    .text(label, x + 10, y + 10, { width: w - 20, height: 10, lineBreak: false, ellipsis: true });
  // valor em uma linha só: diminui a fonte até caber na largura do cartão
  let size = 16;
  doc.font('Helvetica-Bold');
  while (size > 9 && doc.fontSize(size).widthOfString(value) > w - 20) size -= 1;
  doc
    .fontSize(size)
    .fillColor(color)
    .text(value, x + 10, y + 25 + (16 - size) / 2, { width: w - 20, lineBreak: false, ellipsis: true });
}

function heading(doc: Doc, text: string, y: number) {
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.text).text(text, M, y);
  return y + 18;
}

function coverPage(doc: Doc, data: ReportData) {
  const W = doc.page.width - 2 * M;
  logo(doc, M, M);
  doc
    .font('Helvetica-Bold')
    .fontSize(22)
    .fillColor(C.text)
    .text(data.title, M, M + 52, { width: W });
  let y = doc.y + 4;
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor(C.muted)
    .text(`Período: ${periodLabel(data.from)}`, M, y);
  y = doc.y + 2;
  const meta = [
    `Gerado em ${dateTime(data.generatedAt)}`,
    data.author ? `Preparado por ${data.author}` : null,
  ].filter(Boolean);
  doc.text(meta.join(' · '), M, y);
  y = doc.y + 22;

  const withData = data.sites.filter((s) => s.uptime !== null);
  const avg = withData.length ? withData.reduce((a, s) => a + (s.uptime ?? 0), 0) / withData.length : null;
  const incidents = data.sites.reduce((a, s) => a + s.incidents.length, 0);
  const down = data.sites.reduce((a, s) => a + s.downtimeMs, 0);
  const cw = (W - 3 * 10) / 4;
  card(doc, M, y, cw, 'Sites monitorados', String(data.sites.length));
  card(doc, M + (cw + 10), y, cw, 'Uptime médio', pct(avg), avg === null ? C.muted : uptimeColor(avg));
  card(doc, M + 2 * (cw + 10), y, cw, 'Quedas no período', String(incidents), incidents ? C.red : C.brand);
  card(doc, M + 3 * (cw + 10), y, cw, 'Tempo fora do ar', formatDuration(down), down ? C.red : C.brand);
  y += 76;

  y = heading(doc, 'Resumo por site', y);
  const cols = [
    { h: 'Site', w: 0.27 },
    { h: 'Saúde', w: 0.09 },
    { h: 'Uptime', w: 0.11 },
    { h: 'Quedas', w: 0.09 },
    { h: 'Fora do ar', w: 0.13 },
    { h: 'Resposta', w: 0.11 },
    { h: 'SSL', w: 0.1 },
    { h: 'Domínio', w: 0.1 },
  ].map((c) => ({ ...c, w: c.w * W }));
  const row = (cells: { t: string; color?: string; bold?: boolean }[], yy: number, fill?: string) => {
    if (fill) doc.rect(M, yy - 4, W, 20).fill(fill);
    let x = M;
    cells.forEach((c, i) => {
      doc
        .font(c.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(9)
        .fillColor(c.color ?? C.text)
        .text(c.t, x + 4, yy, { width: cols[i].w - 8, lineBreak: false, ellipsis: true });
      x += cols[i].w;
    });
  };
  row(
    cols.map((c) => ({ t: c.h, color: C.muted, bold: true })),
    y,
  );
  y += 18;
  doc
    .moveTo(M, y - 4)
    .lineTo(M + W, y - 4)
    .lineWidth(0.5)
    .strokeColor(C.line)
    .stroke();
  data.sites.forEach((s, i) => {
    if (y > doc.page.height - 120) {
      doc.addPage();
      y = M;
    }
    row(
      [
        { t: s.name, bold: true },
        {
          t: s.healthScore === null ? '—' : String(s.healthScore),
          color: scoreColor(s.healthScore),
          bold: true,
        },
        { t: pct(s.uptime), color: s.uptime === null ? C.muted : uptimeColor(s.uptime) },
        { t: String(s.incidents.length), color: s.incidents.length ? C.red : C.text },
        { t: formatDuration(s.downtimeMs) },
        { t: s.avgResponseMs === null ? '—' : `${s.avgResponseMs} ms` },
        { t: days(s.sslDays), color: s.sslDays !== null && s.sslDays <= 14 ? C.amber : C.text },
        { t: days(s.domainDays), color: s.domainDays !== null && s.domainDays <= 30 ? C.amber : C.text },
      ],
      y,
      i % 2 ? C.soft : undefined,
    );
    y += 20;
  });

  const partial = data.sites.filter((s) => s.coverage < 95);
  if (partial.length) {
    y += 8;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(C.amber)
      .text(
        `Monitoramento parcial no período: ${partial.map((s) => `${s.name} (${String(s.coverage).replace('.', ',')}% das checagens previstas)`).join('; ')}. Os números refletem apenas o tempo efetivamente monitorado.`,
        M,
        y,
        { width: W },
      );
  }
}

function sitePage(doc: Doc, s: ReportSite) {
  doc.addPage();
  const W = doc.page.width - 2 * M;
  doc.font('Helvetica-Bold').fontSize(18).fillColor(C.text).text(s.name, M, M, { width: W });
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(C.muted)
    .text(s.url, M, doc.y + 2, { width: W, link: s.url });
  let y = doc.y + 16;

  const cw = (W - 4 * 10) / 5;
  card(
    doc,
    M,
    y,
    cw,
    'Nota de saúde',
    s.healthScore === null ? '—' : String(s.healthScore),
    scoreColor(s.healthScore),
  );
  card(
    doc,
    M + (cw + 10),
    y,
    cw,
    'Uptime no período',
    pct(s.uptime),
    s.uptime === null ? C.muted : uptimeColor(s.uptime),
  );
  card(
    doc,
    M + 2 * (cw + 10),
    y,
    cw,
    'Tempo fora do ar',
    formatDuration(s.downtimeMs),
    s.downtimeMs ? C.red : C.brand,
  );
  card(
    doc,
    M + 3 * (cw + 10),
    y,
    cw,
    'Resposta / p95',
    s.avgResponseMs === null ? '—' : `${s.avgResponseMs} / ${s.p95ResponseMs} ms`,
  );
  card(
    doc,
    M + 4 * (cw + 10),
    y,
    cw,
    'Segurança',
    s.securityScore === null ? '—' : String(s.securityScore),
    scoreColor(s.securityScore),
  );
  y += 76;

  // Uptime dia a dia
  y = heading(doc, 'Disponibilidade dia a dia', y);
  const n = s.daily.length;
  const gap = 2;
  const bw = (W - gap * (n - 1)) / n;
  s.daily.forEach((u, i) => {
    const h = u === null ? 6 : 8 + (Math.max(0, u - 90) / 10) * 40; // destaca a faixa 90–100%
    doc.rect(M + i * (bw + gap), y + 48 - h, bw, h).fill(uptimeColor(u));
  });
  doc.font('Helvetica').fontSize(7).fillColor(C.muted);
  s.daily.forEach((_, i) => {
    if (i % 5 === 0 || i === n - 1)
      doc.text(String(i + 1), M + i * (bw + gap) - 4, y + 52, { width: bw + 8, align: 'center' });
  });
  doc
    .fontSize(7)
    .text(
      'Verde: 99,5% ou mais · Amarelo: 95–99,5% · Vermelho: abaixo de 95% · Cinza: sem checagens',
      M,
      y + 64,
      { width: W },
    );
  y += 84;
  if (s.coverage < 95) {
    doc
      .fontSize(8)
      .fillColor(C.amber)
      .text(
        `Monitoramento parcial: ${String(s.coverage).replace('.', ',')}% das checagens previstas no período.`,
        M,
        y,
        { width: W },
      );
    y = doc.y + 10;
  }

  // Quedas
  y = heading(doc, `Quedas (${s.incidents.length})`, y);
  if (s.incidents.length === 0) {
    doc.font('Helvetica').fontSize(9).fillColor(C.brand).text('Nenhuma queda registrada no período.', M, y);
    y = doc.y + 14;
  } else {
    const shown = s.incidents.slice(0, 12);
    for (const inc of shown) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(C.text)
        .text(dateTime(inc.start), M, y, { width: 110, lineBreak: false });
      doc
        .fillColor(inc.end ? C.text : C.red)
        .text(inc.end ? formatDuration(inc.durationMs) : 'em andamento', M + 115, y, {
          width: 90,
          lineBreak: false,
        });
      doc
        .fillColor(C.muted)
        .text(inc.reason ?? 'falha', M + 210, y, { width: W - 210, lineBreak: false, ellipsis: true });
      y += 15;
    }
    if (s.incidents.length > shown.length) {
      doc
        .fontSize(8)
        .fillColor(C.muted)
        .text(`+ ${s.incidents.length - shown.length} queda(s) no período`, M, y);
      y += 14;
    }
    y += 6;
  }

  // Segurança
  y = heading(doc, 'Segurança (pendências da última auditoria)', y);
  if (s.findings.length === 0) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(s.securityScore === null ? C.muted : C.brand);
    doc.text(s.securityScore === null ? 'Site ainda não auditado.' : 'Nenhuma pendência encontrada.', M, y);
    y = doc.y + 14;
  } else {
    const order: Severity[] = ['critical', 'high', 'medium', 'low'];
    const sorted = [...s.findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
    for (const f of sorted.slice(0, 10)) {
      const sev = SEVERITY[f.severity];
      doc.roundedRect(M, y - 1, 46, 12, 3).fill(sev.color);
      doc
        .font('Helvetica-Bold')
        .fontSize(7)
        .fillColor('#ffffff')
        .text(sev.label, M, y + 1.5, { width: 46, align: 'center' });
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(C.text)
        .text(f.title, M + 54, y, { width: W - 54, lineBreak: false, ellipsis: true });
      y += 16;
    }
    if (sorted.length > 10) {
      doc
        .fontSize(8)
        .fillColor(C.muted)
        .text(`+ ${sorted.length - 10} item(ns)`, M, y);
      y += 14;
    }
    y += 6;
  }

  // Vencimentos
  y = heading(doc, 'Vencimentos', y);
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(C.text)
    .text(`Certificado SSL: ${days(s.sslDays)}    ·    Domínio: ${days(s.domainDays)}`, M, y);
}

/** Gera o PDF do relatório. compress=false deixa o texto legível no arquivo (usado nos testes). */
export function renderReport(data: ReportData, options: { compress?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: M,
      bufferPages: true,
      compress: options.compress ?? true,
      info: {
        Title: data.title,
        Author: data.author ?? 'Uivo',
        Creator: 'Uivo',
        Subject: periodLabel(data.from),
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    coverPage(doc, data);
    for (const s of data.sites) sitePage(doc, s);

    // Rodapé em todas as páginas
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // o rodapé fica abaixo da margem: sem zerá-la, o pdfkit criaria uma página nova para ele
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = doc.page.height - 32;
      doc
        .moveTo(M, y - 8)
        .lineTo(doc.page.width - M, y - 8)
        .lineWidth(0.5)
        .strokeColor(C.line)
        .stroke();
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(C.muted)
        .text(`${data.title} · ${periodLabel(data.from)} · gerado pelo Uivo`, M, y, { lineBreak: false })
        .text(`página ${i - range.start + 1} de ${range.count}`, M, y, {
          width: doc.page.width - 2 * M,
          align: 'right',
          lineBreak: false,
        });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}
