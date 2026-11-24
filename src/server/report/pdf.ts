import PDFDocument from 'pdfkit';
import { BRAND } from '../../shared/brand.ts';
import type { Severity } from '../checks/security.ts';
import type { ReportData, ReportIncident, ReportSite } from './data.ts';

/*
 * Relatório mensal pensado para quem não é da área: cada número vem com uma frase dizendo o que
 * ele significa, os gráficos têm faixas de "bom / aceitável / ruim" e no fim há um glossário.
 */

const C = {
  text: '#18181b',
  muted: '#71717a',
  faint: '#a1a1aa',
  line: '#e4e4e7',
  soft: '#f4f4f5',
  ice: BRAND.ice.onLight,
  iceSoft: '#e0f2fe',
  green: '#059669',
  greenSoft: '#d1fae5',
  amber: '#d97706',
  amberSoft: '#fef3c7',
  red: '#dc2626',
  redSoft: '#fee2e2',
  empty: '#e4e4e7',
};
const M = 44; // margem
const W = 595.28 - 2 * M; // largura útil do A4
type Doc = InstanceType<typeof PDFDocument>;
type Tone = 'good' | 'warn' | 'bad' | 'none';
const TONE: Record<Tone, { fg: string; bg: string }> = {
  good: { fg: C.green, bg: C.greenSoft },
  warn: { fg: C.amber, bg: C.amberSoft },
  bad: { fg: C.red, bg: C.redSoft },
  none: { fg: C.muted, bg: C.soft },
};

// ─── textos em linguagem simples ────────────────────────────────────────────

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
  new Date(ts).toLocaleString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
const monthName = (ts: number) => new Date(ts).toLocaleDateString('pt-BR', { month: 'long' });

export function periodLabel(from: number): string {
  const s = new Date(from).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function uptimeTone(u: number | null): Tone {
  if (u === null) return 'none';
  return u >= 99.5 ? 'good' : u >= 98 ? 'warn' : 'bad';
}
function uptimeWord(u: number | null): string {
  if (u === null) return 'sem dados';
  return u >= 99.9 ? 'excelente' : u >= 99.5 ? 'bom' : u >= 98 ? 'regular' : 'ruim';
}
function speed(ms: number | null): { word: string; tone: Tone; hint: string } {
  if (ms === null) return { word: 'sem dados', tone: 'none', hint: 'Não houve resposta para medir.' };
  if (ms < 500) return { word: 'rápido', tone: 'good', hint: 'Abre em menos de meio segundo.' };
  if (ms < 1500)
    return { word: 'aceitável', tone: 'warn', hint: 'Dá para usar, mas o visitante já percebe a espera.' };
  return { word: 'lento', tone: 'bad', hint: 'Visitantes costumam desistir de páginas lentas assim.' };
}
function securityInfo(score: number | null): { word: string; tone: Tone } {
  if (score === null) return { word: 'não auditado', tone: 'none' };
  return score >= 90
    ? { word: 'bem protegido', tone: 'good' }
    : score >= 70
      ? { word: 'pontos a melhorar', tone: 'warn' }
      : { word: 'precisa de atenção', tone: 'bad' };
}

/** Motivo técnico da queda traduzido para o leitor leigo. */
export function plainReason(reason: string | null): string {
  if (!reason) return 'o site não respondeu';
  const http = /HTTP (\d{3})/.exec(reason);
  if (http) {
    const code = Number(http[1]);
    if (code >= 500) return `o servidor do site apresentou um erro interno (código ${code})`;
    if (code === 404) return 'a página não foi encontrada (código 404)';
    if (code === 401 || code === 403) return `o acesso à página foi bloqueado (código ${code})`;
    return `o site respondeu com um erro (código ${code})`;
  }
  if (/esgotado/i.test(reason)) return 'o site demorou demais para responder';
  if (/DNS|não encontrado/i.test(reason)) return 'o endereço do site não foi encontrado na internet (DNS)';
  if (/recusada/i.test(reason)) return 'o servidor recusou a conexão (pode estar desligado)';
  if (/interrompida/i.test(reason)) return 'a conexão caiu no meio do caminho';
  if (/Palavra-chave/i.test(reason))
    return 'a página abriu, mas sem o conteúdo esperado (pode estar em branco ou com erro)';
  if (/Redirecionamentos/i.test(reason)) return 'o site ficou preso num ciclo de redirecionamentos';
  if (/certificado|SSL|TLS/i.test(reason)) return 'houve um problema no certificado de segurança (cadeado)';
  return reason;
}

function situation(s: ReportSite): { word: string; tone: Tone } {
  const open = s.incidents.some((i) => i.end === null);
  if (
    open ||
    (s.uptime !== null && s.uptime < 98) ||
    (s.sslDays !== null && s.sslDays <= 3) ||
    (s.domainDays !== null && s.domainDays <= 7)
  )
    return { word: 'Problema', tone: 'bad' };
  if (
    (s.uptime !== null && s.uptime < 99.5) ||
    (s.sslDays !== null && s.sslDays <= 14) ||
    (s.domainDays !== null && s.domainDays <= 30) ||
    (s.securityScore !== null && s.securityScore < 70) ||
    speed(s.avgResponseMs).tone === 'bad'
  )
    return { word: 'Atenção', tone: 'warn' };
  if (s.uptime === null) return { word: 'Sem dados', tone: 'none' };
  return { word: 'Tudo certo', tone: 'good' };
}

/** Recomendações práticas, em ordem de urgência. */
function todo(s: ReportSite): { tone: Tone; text: string }[] {
  const out: { tone: Tone; text: string }[] = [];
  if (s.sslDays !== null && s.sslDays <= 14)
    out.push({
      tone: s.sslDays <= 3 ? 'bad' : 'warn',
      text:
        s.sslDays < 0
          ? 'Renovar o certificado SSL: ele já venceu e o navegador mostra "site não seguro".'
          : `Renovar o certificado SSL (vence em ${s.sslDays} dias). Sem ele, o navegador avisa que o site "não é seguro".`,
    });
  if (s.domainDays !== null && s.domainDays <= 30)
    out.push({
      tone: s.domainDays <= 7 ? 'bad' : 'warn',
      text:
        s.domainDays < 0
          ? 'Renovar o domínio: ele venceu e o site pode sair do ar a qualquer momento.'
          : `Renovar o domínio (vence em ${s.domainDays} dias). Se vencer, o endereço deixa de funcionar.`,
    });
  if (s.incidents.length >= 3 || (s.uptime !== null && s.uptime < 99.5))
    out.push({
      tone: 'warn',
      text: `Conversar com a hospedagem: foram ${s.incidents.length} quedas no mês. Vale pedir a causa e uma solução definitiva.`,
    });
  if (speed(s.avgResponseMs).tone !== 'good' && s.avgResponseMs !== null)
    out.push({
      tone: 'warn',
      text: 'Pedir ao desenvolvedor uma revisão de desempenho (cache, imagens e hospedagem): o site está mais lento que o ideal.',
    });
  const serious = s.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  if (serious.length)
    out.push({
      tone: 'bad',
      text: `Corrigir ${serious.length} falha(s) de segurança grave(s) listadas abaixo.`,
    });
  else if (s.findings.length)
    out.push({
      tone: 'warn',
      text: `Pedir ao desenvolvedor os ajustes de segurança listados abaixo (${s.findings.length}).`,
    });
  if (out.length === 0)
    out.push({ tone: 'good', text: 'Nada urgente. Continue acompanhando pelo relatório do próximo mês.' });
  return out;
}

// ─── blocos de desenho ───────────────────────────────────────────────────────

function logo(doc: Doc, x: number, y: number, height = 30) {
  const scale = height / BRAND.height;
  doc.save().translate(x, y).scale(scale);
  doc.path(BRAND.wordmark).fillColor(C.text).fill();
  BRAND.arcs.forEach((d, i) => {
    doc
      .path(d)
      .lineWidth(2.2)
      .lineCap('round')
      .strokeOpacity(BRAND.arcOpacity[i])
      .strokeColor(C.ice)
      .stroke();
  });
  doc.restore();
}

function label(doc: Doc, text: string, x: number, y: number, width = W) {
  doc
    .font('Helvetica-Bold')
    .fontSize(7.5)
    .fillColor(C.ice)
    .text(text.toUpperCase(), x, y, { width, characterSpacing: 0.8 });
}

function heading(doc: Doc, text: string, y: number, sub?: string) {
  doc.font('Helvetica-Bold').fontSize(12.5).fillColor(C.text).text(text, M, y, { width: W });
  let yy = doc.y + 1;
  if (sub) {
    doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(sub, M, yy, { width: W });
    yy = doc.y;
  }
  return yy + 8;
}

function pill(doc: Doc, text: string, tone: Tone, x: number, y: number) {
  doc.font('Helvetica-Bold').fontSize(8);
  const w = doc.widthOfString(text) + 18;
  doc.roundedRect(x, y, w, 16, 8).fill(TONE[tone].bg);
  doc.circle(x + 8, y + 8, 2.6).fill(TONE[tone].fg);
  doc.fillColor(TONE[tone].fg).text(text, x + 13, y + 4.6, { lineBreak: false });
  return w;
}

/** Cartão com número grande e uma frase explicando o que ele quer dizer. */
function card(
  doc: Doc,
  x: number,
  y: number,
  w: number,
  h: number,
  o: { title: string; value: string; word: string; tone: Tone; hint: string },
) {
  doc.roundedRect(x, y, w, h, 6).fill(C.soft);
  doc.rect(x, y + 10, 2.5, h - 20).fill(TONE[o.tone].fg);
  doc
    .font('Helvetica-Bold')
    .fontSize(7.5)
    .fillColor(C.muted)
    .text(o.title.toUpperCase(), x + 12, y + 10, { width: w - 22, characterSpacing: 0.6 });
  let size = 19;
  doc.font('Helvetica-Bold');
  while (size > 11 && doc.fontSize(size).widthOfString(o.value) > w - 24) size -= 1;
  doc
    .fontSize(size)
    .fillColor(C.text)
    .text(o.value, x + 12, y + 23, { width: w - 22, lineBreak: false });
  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor(TONE[o.tone].fg)
    .text(o.word, x + 12, y + 47, { width: w - 22 });
  doc
    .font('Helvetica')
    .fontSize(7.8)
    .fillColor(C.muted)
    .text(o.hint, x + 12, doc.y + 1.5, { width: w - 22, height: h - (doc.y - y) - 6, ellipsis: true });
}

/** Barras de disponibilidade por dia. */
function dailyBars(doc: Doc, s: ReportSite, y: number) {
  const n = s.daily.length;
  const gap = 2;
  const bw = (W - gap * (n - 1)) / n;
  const H = 46;
  s.daily.forEach((u, i) => {
    const h = u === null ? 4 : 6 + (Math.max(0, u - 90) / 10) * (H - 6);
    const tone = uptimeTone(u);
    doc.rect(M + i * (bw + gap), y + H - h, bw, h).fill(u === null ? C.empty : TONE[tone].fg);
  });
  doc.font('Helvetica').fontSize(6.8).fillColor(C.faint);
  s.daily.forEach((_, i) => {
    if (i % 5 === 0 || i === n - 1)
      doc.text(String(i + 1), M + i * (bw + gap) - 4, y + H + 3, { width: bw + 8, align: 'center' });
  });
  legend(doc, y + H + 14, [
    [C.green, 'no ar o dia todo (99,5% ou mais)'],
    [C.amber, 'instabilidade'],
    [C.red, 'fora do ar por bastante tempo'],
    [C.empty, 'sem monitoramento'],
  ]);
  return y + H + 28;
}

function legend(doc: Doc, y: number, items: [string, string][]) {
  let x = M;
  doc.font('Helvetica').fontSize(7);
  for (const [color, text] of items) {
    doc.rect(x, y + 1, 6, 6).fill(color);
    doc.fillColor(C.muted).text(text, x + 9, y, { lineBreak: false });
    x += 9 + doc.widthOfString(text) + 14;
  }
}

/** Linha da velocidade dia a dia sobre faixas de rápido / aceitável / lento. */
function speedChart(doc: Doc, s: ReportSite, y: number) {
  const H = 92;
  const left = M + 34;
  const cw = W - 34;
  const values = s.dailyMs.filter((v): v is number => v !== null);
  const top = Math.max(800, Math.ceil((Math.max(0, ...values) * 1.2) / 200) * 200);
  const yOf = (ms: number) => y + H - (Math.min(ms, top) / top) * H;
  // faixas
  const bands: [number, number, string][] = [
    [0, 500, '#ecfdf5'],
    [500, 1500, '#fffbeb'],
    [1500, top, '#fef2f2'],
  ];
  for (const [a, b, color] of bands) {
    if (a >= top) continue;
    doc.rect(left, yOf(Math.min(b, top)), cw, yOf(a) - yOf(Math.min(b, top))).fill(color);
  }
  // eixo
  doc.font('Helvetica').fontSize(6.8).fillColor(C.faint);
  for (const v of [0, top / 2, top]) {
    doc.text(`${Math.round(v)} ms`, M - 4, yOf(v) - 3, { width: 34, align: 'right' });
    doc
      .moveTo(left, yOf(v))
      .lineTo(left + cw, yOf(v))
      .lineWidth(0.4)
      .strokeColor(C.line)
      .stroke();
  }
  // linha (com quebras nos dias sem dados)
  const n = s.dailyMs.length;
  const xOf = (i: number) => left + (n === 1 ? cw / 2 : (i / (n - 1)) * cw);
  let drawing = false;
  s.dailyMs.forEach((v, i) => {
    if (v === null) {
      drawing = false;
      return;
    }
    if (!drawing) doc.moveTo(xOf(i), yOf(v));
    else doc.lineTo(xOf(i), yOf(v));
    drawing = true;
  });
  doc.lineWidth(1.6).lineJoin('round').strokeColor(C.ice).stroke();
  s.dailyMs.forEach((v, i) => {
    if (v !== null) doc.circle(xOf(i), yOf(v), 1.6).fill(C.ice);
  });
  doc.font('Helvetica').fontSize(6.8).fillColor(C.faint);
  s.dailyMs.forEach((_, i) => {
    if (i % 5 === 0 || i === n - 1)
      doc.text(String(i + 1), xOf(i) - 6, y + H + 3, { width: 12, align: 'center' });
  });
  legend(doc, y + H + 14, [
    ['#bbf7d0', 'rápido (até 0,5 s)'],
    ['#fde68a', 'aceitável (até 1,5 s)'],
    ['#fecaca', 'lento'],
    [C.ice, 'tempo médio do dia'],
  ]);
  return y + H + 28;
}

/** Barras por hora do dia: quando o site fica mais lento. */
function hourChart(doc: Doc, s: ReportSite, y: number) {
  const H = 58;
  const valid = s.hourlyMs.filter((v): v is number => v !== null);
  if (valid.length < 6) {
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(C.muted)
      .text('Ainda não há dados suficientes para comparar os horários.', M, y);
    return doc.y + 8;
  }
  const max = Math.max(...valid);
  const min = Math.min(...valid);
  const gap = 3;
  const bw = (W - gap * 23) / 24;
  // as 3 horas mais lentas ganham destaque
  const slowest = [...s.hourlyMs.entries()]
    .filter(([, v]) => v !== null)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 3)
    .map(([h]) => h);
  s.hourlyMs.forEach((v, h) => {
    const bh = v === null ? 3 : 6 + ((v - min) / Math.max(1, max - min)) * (H - 6);
    doc
      .rect(M + h * (bw + gap), y + H - bh, bw, bh)
      .fill(v === null ? C.empty : slowest.includes(h) ? C.amber : '#7dd3fc');
  });
  doc.font('Helvetica').fontSize(6.8).fillColor(C.faint);
  for (let h = 0; h < 24; h += 3)
    doc.text(`${h}h`, M + h * (bw + gap) - 2, y + H + 3, { width: bw + 4, align: 'center' });
  const hours = [...slowest].sort((a, b) => a - b).map((h) => `${h}h`);
  const avgSlow = Math.round(slowest.reduce((a, h) => a + (s.hourlyMs[h] ?? 0), 0) / slowest.length);
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(C.text)
    .text(`Os horários mais lentos foram ${hours.join(', ')} (média de ${avgSlow} ms). `, M, y + H + 16, {
      width: W,
      continued: true,
    })
    .fillColor(C.muted)
    .text(
      max - min < 80
        ? 'A diferença entre o horário mais rápido e o mais lento é pequena: o site se comporta bem o dia todo.'
        : 'Costumam ser os horários de mais movimento; se for o seu pico de vendas, vale melhorar a hospedagem.',
    );
  return doc.y + 8;
}

// ─── páginas ───────────────────────────────────────────────────────────────

function coverPage(doc: Doc, data: ReportData) {
  logo(doc, M, M, 30);
  label(doc, 'Relatório mensal de monitoramento', M, M + 52);
  doc
    .font('Helvetica-Bold')
    .fontSize(23)
    .fillColor(C.text)
    .text(data.title, M, M + 64, { width: W });
  const meta = [
    periodLabel(data.from),
    data.author ? `preparado por ${data.author}` : null,
    `gerado em ${new Date(data.generatedAt).toLocaleDateString('pt-BR')}`,
  ]
    .filter(Boolean)
    .join('  ·  ');
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(C.muted)
    .text(meta, M, doc.y + 4, { width: W });
  let y = doc.y + 18;

  // veredito em uma frase + os destaques
  const withData = data.sites.filter((s) => s.uptime !== null);
  const avg = withData.length ? withData.reduce((a, s) => a + (s.uptime ?? 0), 0) / withData.length : null;
  const incidents = data.sites.reduce((a, s) => a + s.incidents.length, 0);
  const down = data.sites.reduce((a, s) => a + s.downtimeMs, 0);
  const fast = withData
    .filter((s) => s.avgResponseMs !== null)
    .sort((a, b) => (a.avgResponseMs ?? 0) - (b.avgResponseMs ?? 0));
  const issues = data.sites.flatMap((s) =>
    todo(s)
      .filter((t) => t.tone !== 'good')
      .map((t) => ({ ...t, site: s.name })),
  );
  const n = data.sites.length;
  const headline =
    avg === null
      ? `Ainda não há dados de ${monthName(data.from)} para os sites escolhidos.`
      : `Em ${monthName(data.from)}, ${n === 1 ? 'seu site ficou' : `seus ${n} sites ficaram`} no ar ${pct(avg)} do tempo.`;
  const bullets = [
    incidents
      ? `Houve ${incidents} queda${incidents > 1 ? 's' : ''}, somando ${formatDuration(down)} fora do ar.`
      : 'Nenhuma queda registrada no mês.',
    fast.length > 1 && fast[0].avgResponseMs === fast[fast.length - 1].avgResponseMs
      ? `Todos responderam, em média, em ${fast[0].avgResponseMs} ms (${speed(fast[0].avgResponseMs).word}).`
      : fast.length > 1
        ? `Mais rápido: ${fast[0].name} (${fast[0].avgResponseMs} ms). Mais lento: ${fast[fast.length - 1].name} (${fast[fast.length - 1].avgResponseMs} ms).`
        : fast.length === 1
          ? `Tempo médio de resposta: ${fast[0].avgResponseMs} ms (${speed(fast[0].avgResponseMs).word}).`
          : null,
    issues.length
      ? `${issues.length} ponto${issues.length > 1 ? 's pedem' : ' pede'} atenção (detalhes abaixo).`
      : 'Nada pedindo atenção: tudo dentro do esperado.',
  ].filter((b): b is string => b !== null);
  doc.font('Helvetica-Bold').fontSize(13.5);
  const hh = doc.heightOfString(headline, { width: W - 36 });
  const boxH = 26 + hh + bullets.length * 15 + 6;
  doc.roundedRect(M, y, W, boxH, 8).fill(C.iceSoft);
  doc.rect(M, y, 3, boxH).fill(C.ice);
  doc.fillColor(C.text).text(headline, M + 18, y + 16, { width: W - 36 });
  let by = doc.y + 6;
  for (const b of bullets) {
    doc.circle(M + 22, by + 4.5, 1.8).fill(C.ice);
    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor(C.text)
      .text(b, M + 30, by, { width: W - 48 });
    by = doc.y + 4;
  }
  y += boxH + 22;

  // tabela: situação de cada site
  y = heading(doc, 'Situação de cada site', y);
  const cols = [
    { h: 'Site', w: 0.3 },
    { h: 'Situação', w: 0.17 },
    { h: 'No ar', w: 0.12 },
    { h: 'Quedas', w: 0.1 },
    { h: 'Fora do ar', w: 0.14 },
    { h: 'Velocidade', w: 0.17 },
  ].map((c) => ({ ...c, w: c.w * W }));
  let x = M;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.muted);
  for (const c of cols) {
    doc.text(c.h.toUpperCase(), x + 4, y, { width: c.w - 8, characterSpacing: 0.5 });
    x += c.w;
  }
  y += 14;
  doc
    .moveTo(M, y - 3)
    .lineTo(M + W, y - 3)
    .lineWidth(0.6)
    .strokeColor(C.line)
    .stroke();
  for (const [i, s] of data.sites.entries()) {
    if (y > doc.page.height - 150) {
      doc.addPage();
      y = M;
    }
    if (i % 2) doc.rect(M, y - 3, W, 24).fill(C.soft);
    const sit = situation(s);
    const sp = speed(s.avgResponseMs);
    x = M;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(C.text)
      .text(s.name, x + 4, y + 4, { width: cols[0].w - 8, lineBreak: false, ellipsis: true });
    x += cols[0].w;
    pill(doc, sit.word, sit.tone, x + 2, y + 1);
    x += cols[1].w;
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(TONE[uptimeTone(s.uptime)].fg)
      .text(pct(s.uptime), x + 4, y + 4, { width: cols[2].w - 8, lineBreak: false });
    x += cols[2].w;
    doc
      .fillColor(s.incidents.length ? C.red : C.text)
      .text(String(s.incidents.length), x + 4, y + 4, { width: cols[3].w - 8, lineBreak: false });
    x += cols[3].w;
    doc
      .fillColor(C.text)
      .text(formatDuration(s.downtimeMs), x + 4, y + 4, { width: cols[4].w - 8, lineBreak: false });
    x += cols[4].w;
    doc
      .fillColor(TONE[sp.tone].fg)
      .text(s.avgResponseMs === null ? '—' : `${sp.word} · ${s.avgResponseMs} ms`, x + 4, y + 4, {
        width: cols[5].w - 8,
        lineBreak: false,
        ellipsis: true,
      });
    y += 24;
  }
  y += 14;

  if (issues.length) {
    y = heading(doc, 'Pontos de atenção', y);
    for (const it of issues.slice(0, 7)) {
      if (y > doc.page.height - 90) break;
      doc.rect(M, y + 2, 6, 6).fill(TONE[it.tone].fg);
      doc
        .font('Helvetica-Bold')
        .fontSize(8.8)
        .fillColor(C.text)
        .text(`${it.site}: `, M + 14, y, { width: W - 14, continued: true });
      doc.font('Helvetica').fillColor(C.muted).text(it.text);
      y = doc.y + 5;
    }
  }

  const partial = data.sites.filter((s) => s.coverage < 95 && s.checks > 0);
  if (partial.length && y < doc.page.height - 80) {
    doc
      .font('Helvetica')
      .fontSize(7.8)
      .fillColor(C.amber)
      .text(
        `Monitoramento parcial: ${partial.map((s) => `${s.name} (${String(s.coverage).replace('.', ',')}% do mês)`).join('; ')}. Os números valem só para o tempo em que o monitor esteve ligado.`,
        M,
        y + 6,
        { width: W },
      );
  }
}

function siteHeader(doc: Doc, s: ReportSite, part: string) {
  label(doc, part, M, M);
  doc
    .font('Helvetica-Bold')
    .fontSize(19)
    .fillColor(C.text)
    .text(s.name, M, M + 12, { width: W - 120 });
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(C.muted)
    .text(s.url, M, doc.y + 1, { width: W - 120, link: s.url });
  const after = doc.y; // o selo abaixo mexe na posição do texto; guarda antes
  const sit = situation(s);
  doc.font('Helvetica-Bold').fontSize(8);
  const w = doc.widthOfString(sit.word) + 18;
  pill(doc, sit.word, sit.tone, M + W - w, M + 18);
  return after + 16;
}

function compareLine(s: ReportSite, from: number): string | null {
  const prev = s.previous;
  const parts: string[] = [];
  const prevMonth = new Date(
    new Date(from).getFullYear(),
    new Date(from).getMonth() - 1,
    1,
  ).toLocaleDateString('pt-BR', { month: 'long' });
  if (prev.uptime !== null && s.uptime !== null) {
    const d = s.uptime - prev.uptime;
    parts.push(
      Math.abs(d) < 0.05
        ? `a disponibilidade ficou igual (${pct(s.uptime)})`
        : `a disponibilidade ${d > 0 ? 'subiu' : 'caiu'} de ${pct(prev.uptime)} para ${pct(s.uptime)}`,
    );
  }
  if (prev.avgResponseMs && s.avgResponseMs) {
    const d = Math.round(((s.avgResponseMs - prev.avgResponseMs) / prev.avgResponseMs) * 100);
    parts.push(
      Math.abs(d) < 5
        ? 'a velocidade se manteve'
        : `o site ficou ${Math.abs(d)}% mais ${d < 0 ? 'rápido' : 'lento'}`,
    );
  }
  return parts.length ? `Comparado com ${prevMonth}: ${parts.join(' e ')}.` : null;
}

function sitePageNumbers(doc: Doc, data: ReportData, s: ReportSite) {
  doc.addPage();
  let y = siteHeader(doc, s, 'Visão geral do mês');
  const sp = speed(s.avgResponseMs);
  const sec = securityInfo(s.securityScore);
  const validity = Math.min(s.sslDays ?? 9999, s.domainDays ?? 9999);
  const vTone: Tone = validity === 9999 ? 'none' : validity <= 7 ? 'bad' : validity <= 30 ? 'warn' : 'good';
  const cw = (W - 3 * 8) / 4;
  const ch = 96;
  card(doc, M, y, cw, ch, {
    title: 'No ar',
    value: pct(s.uptime),
    word: uptimeWord(s.uptime),
    tone: uptimeTone(s.uptime),
    hint: s.downtimeMs
      ? `Ficou fora do ar ${formatDuration(s.downtimeMs)} no mês.`
      : 'Nenhum minuto fora do ar.',
  });
  card(doc, M + (cw + 8), y, cw, ch, {
    title: 'Velocidade',
    value: s.avgResponseMs === null ? '—' : `${s.avgResponseMs} ms`,
    word: sp.word,
    tone: sp.tone,
    hint: sp.hint,
  });
  card(doc, M + 2 * (cw + 8), y, cw, ch, {
    title: 'Segurança',
    value: s.securityScore === null ? '—' : `${s.securityScore}/100`,
    word: sec.word,
    tone: sec.tone,
    hint: s.findings.length
      ? `${s.findings.length} ajuste(s) recomendado(s) na próxima página.`
      : 'Nenhum problema encontrado.',
  });
  card(doc, M + 3 * (cw + 8), y, cw, ch, {
    title: 'Validade',
    value: validity === 9999 ? '—' : validity < 0 ? 'vencido' : `${validity} dias`,
    word: vTone === 'good' ? 'em dia' : vTone === 'none' ? 'não verificado' : 'renovar logo',
    tone: vTone,
    hint: 'Até o próximo vencimento (certificado ou domínio).',
  });
  y += ch + 12;
  const cmp = compareLine(s, data.from);
  if (cmp) {
    doc.font('Helvetica').fontSize(9).fillColor(C.text).text(cmp, M, y, { width: W });
    y = doc.y + 4;
  }
  if (s.coverage < 95 && s.checks > 0) {
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(C.amber)
      .text(
        `Monitorado em ${String(s.coverage).replace('.', ',')}% do mês: os números valem só para esse período.`,
        M,
        y,
        { width: W },
      );
    y = doc.y + 4;
  }
  y += 10;
  y = heading(
    doc,
    'Disponibilidade dia a dia',
    y,
    'Cada barra é um dia: quanto mais alta e verde, mais tempo o site ficou no ar.',
  );
  y = dailyBars(doc, s, y);
  y += 6;
  y = heading(
    doc,
    'Velocidade dia a dia',
    y,
    'Tempo médio que o site levou para responder em cada dia (quanto mais baixo, melhor).',
  );
  y = speedChart(doc, s, y);
  y += 6;
  y = heading(
    doc,
    'Horários mais lentos',
    y,
    'Tempo médio de resposta em cada hora do dia, somando o mês todo.',
  );
  hourChart(doc, s, y);
}

function incidentLine(doc: Doc, inc: ReportIncident, y: number) {
  doc.rect(M, y + 3, 6, 6).fill(inc.end ? C.red : C.amber);
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(C.text)
    .text(dateTime(inc.start), M + 14, y, { width: 150, lineBreak: false });
  doc
    .font('Helvetica')
    .fillColor(C.text)
    .text(inc.end ? `fora do ar por ${formatDuration(inc.durationMs)}` : 'ainda fora do ar', M + 165, y, {
      width: 120,
      lineBreak: false,
    });
  doc.fillColor(C.muted).text(plainReason(inc.reason), M + 290, y, { width: W - 290 });
  return Math.max(doc.y, y + 12) + 5;
}

const SEV_WORD: Record<Severity, { word: string; tone: Tone }> = {
  critical: { word: 'urgente', tone: 'bad' },
  high: { word: 'importante', tone: 'bad' },
  medium: { word: 'recomendado', tone: 'warn' },
  low: { word: 'opcional', tone: 'none' },
};

function sitePageDetails(doc: Doc, s: ReportSite) {
  doc.addPage();
  let y = siteHeader(doc, s, 'Detalhes e próximos passos');

  y = heading(doc, 'O que fazer agora', y);
  for (const t of todo(s)) {
    doc.roundedRect(M, y, W, 1, 0).fill(C.soft);
    doc
      .rect(M, y + 7, 7, 7)
      .lineWidth(1)
      .strokeColor(TONE[t.tone].fg)
      .stroke();
    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor(C.text)
      .text(t.text, M + 16, y + 5, { width: W - 16 });
    y = doc.y + 7;
  }
  y += 10;

  y = heading(
    doc,
    `Quedas no mês (${s.incidents.length})`,
    y,
    s.incidents.length ? 'Quando o site ficou fora do ar, por quanto tempo e por quê.' : undefined,
  );
  if (s.incidents.length === 0) {
    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor(C.green)
      .text('Nenhuma queda: o site respondeu o mês inteiro.', M, y);
    y = doc.y + 16;
  } else {
    for (const inc of s.incidents.slice(0, 10)) y = incidentLine(doc, inc, y);
    if (s.incidents.length > 10) {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(C.muted)
        .text(`+ ${s.incidents.length - 10} queda(s) no período`, M, y);
      y = doc.y + 6;
    }
    y += 10;
  }

  y = heading(
    doc,
    'Segurança: o que pedir ao seu desenvolvedor',
    y,
    s.findings.length
      ? 'Pode encaminhar esta lista: cada item já diz o que precisa ser ajustado.'
      : undefined,
  );
  if (s.securityScore === null) {
    doc.font('Helvetica').fontSize(9.5).fillColor(C.muted).text('O site ainda não foi auditado.', M, y);
    y = doc.y + 16;
  } else if (s.findings.length === 0) {
    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor(C.green)
      .text('Nenhum problema de segurança encontrado na última verificação.', M, y);
    y = doc.y + 16;
  } else {
    const order: Severity[] = ['critical', 'high', 'medium', 'low'];
    for (const f of [...s.findings]
      .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
      .slice(0, 6)) {
      if (y > doc.page.height - 120) break;
      const sev = SEV_WORD[f.severity];
      const pw = pill(doc, sev.word, sev.tone, M, y);
      doc
        .font('Helvetica-Bold')
        .fontSize(9.5)
        .fillColor(C.text)
        .text(f.title, M + pw + 8, y + 3, { width: W - pw - 8 });
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(C.muted)
        .text(f.fix, M + pw + 8, doc.y + 1, { width: W - pw - 8 });
      y = doc.y + 9;
    }
    y += 4;
  }

  if (y < doc.page.height - 110) {
    y = heading(doc, 'Vencimentos', y);
    const row = (name: string, days: number | null, what: string) => {
      const tone: Tone = days === null ? 'none' : days <= 7 ? 'bad' : days <= 30 ? 'warn' : 'good';
      doc.rect(M, y + 3, 6, 6).fill(TONE[tone].fg);
      doc
        .font('Helvetica-Bold')
        .fontSize(9.5)
        .fillColor(C.text)
        .text(name, M + 14, y, { width: 150, lineBreak: false });
      doc
        .font('Helvetica')
        .fillColor(TONE[tone].fg)
        .text(days === null ? 'não verificado' : days < 0 ? 'vencido' : `vence em ${days} dias`, M + 165, y, {
          width: 110,
          lineBreak: false,
        });
      doc.fillColor(C.muted).text(what, M + 290, y, { width: W - 290 });
      y = doc.y + 6;
    };
    row(
      'Certificado SSL',
      s.sslDays,
      'É o "cadeado" do navegador. Sem ele, aparece o aviso "site não seguro".',
    );
    row(
      'Domínio',
      s.domainDays,
      'É o endereço do site. Se vencer, o site sai do ar e o nome pode ser perdido.',
    );
  }
}

function glossary(doc: Doc) {
  doc.addPage();
  label(doc, 'Para consulta', M, M);
  doc
    .font('Helvetica-Bold')
    .fontSize(19)
    .fillColor(C.text)
    .text('Como ler este relatório', M, M + 12);
  let y = doc.y + 16;
  const items: [string, string][] = [
    [
      'No ar (disponibilidade)',
      'Porcentagem do tempo em que o site abriu normalmente. 99,5% parece muito, mas ainda são cerca de 3 horas e meia fora do ar num mês; acima de 99,9% é excelente.',
    ],
    [
      'Queda',
      'Período em que o site não abriu. O Uivo só conta como queda depois de duas tentativas seguidas sem resposta, para evitar alarme falso.',
    ],
    [
      'Velocidade (tempo de resposta)',
      'Quanto o servidor demora para começar a entregar a página. Até meio segundo é rápido; acima de um segundo e meio, visitantes começam a desistir.',
    ],
    [
      'Certificado SSL',
      'O "cadeado" ao lado do endereço. Protege os dados de quem visita o site e precisa ser renovado de tempos em tempos (muitas hospedagens fazem isso sozinhas).',
    ],
    [
      'Domínio',
      'O endereço do site (por exemplo, minhaloja.com.br). É alugado por período: se não for renovado, o site sai do ar.',
    ],
    [
      'Nota de segurança',
      'De 0 a 100, a partir de uma verificação diária e passiva: confere se arquivos sensíveis estão expostos, se o site usa as proteções recomendadas e se apareceu algum script estranho na página.',
    ],
    [
      'Monitoramento parcial',
      'Quando o monitor ficou desligado parte do mês, os números valem só para o tempo monitorado; o relatório avisa quando isso acontece.',
    ],
  ];
  for (const [term, text] of items) {
    doc.rect(M, y + 2, 3, 12).fill(C.ice);
    doc
      .font('Helvetica-Bold')
      .fontSize(10.5)
      .fillColor(C.text)
      .text(term, M + 12, y);
    doc
      .font('Helvetica')
      .fontSize(9.3)
      .fillColor(C.muted)
      .text(text, M + 12, doc.y + 2, { width: W - 12, lineGap: 1.5 });
    y = doc.y + 14;
  }
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(C.faint)
    .text(
      'Os dados vêm de checagens automáticas feitas de fora do site, como um visitante faria, várias vezes por hora.',
      M,
      y + 8,
      { width: W },
    );
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
    for (const s of data.sites) {
      sitePageNumbers(doc, data, s);
      sitePageDetails(doc, s);
    }
    glossary(doc);

    // Rodapé em todas as páginas
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // o rodapé fica abaixo da margem: sem zerá-la, o pdfkit criaria uma página nova para ele
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = doc.page.height - 30;
      doc
        .moveTo(M, y - 8)
        .lineTo(doc.page.width - M, y - 8)
        .lineWidth(0.5)
        .strokeColor(C.line)
        .stroke();
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(C.faint)
        .text(`${data.title} · ${periodLabel(data.from)} · gerado pelo Uivo`, M, y, { lineBreak: false })
        .text(`página ${i - range.start + 1} de ${range.count}`, M, y, {
          width: W,
          align: 'right',
          lineBreak: false,
        });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}
