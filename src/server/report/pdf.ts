import path from 'node:path';
import PDFDocument from 'pdfkit';
import { BRAND } from '../../shared/brand.ts';
import type { Severity } from '../checks/security.ts';
import type { ReportData, ReportIncident, ReportSite } from './data.ts';

/*
 * Relatório mensal com a identidade do Uivo: capa escura com o campo de "pixels" em gelo, a fonte
 * Geist embutida e os mesmos quadradinhos do painel nos gráficos. O conteúdo é escrito para quem
 * não é da área: cada número vem com uma frase do que ele significa, e há um glossário no fim.
 */

const FONTS = path.join(import.meta.dirname, 'fonts');
const R = 'Geist';
const MD = 'Geist-Medium';
const SB = 'Geist-SemiBold';

const C = {
  night: '#070a0e',
  nightPanel: '#0d131a',
  ink: '#0b0f14',
  ink2: '#3f3f46',
  muted: '#71717a',
  faint: '#a1a1aa',
  rule: '#e4e4e7',
  wash: '#f6f7f9',
  ice: BRAND.ice.onDark,
  iceDark: BRAND.ice.onLight,
  green: '#059669',
  amber: '#d97706',
  red: '#dc2626',
  empty: '#e4e4e7',
};
const M = 46; // margem
const PW = 595.28;
const PH = 841.89;
const W = PW - 2 * M;
type Doc = InstanceType<typeof PDFDocument>;
type Tone = 'good' | 'warn' | 'bad' | 'none';
const TONE: Record<Tone, string> = { good: C.green, warn: C.amber, bad: C.red, none: C.faint };

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

const uptimeTone = (u: number | null): Tone =>
  u === null ? 'none' : u >= 99.5 ? 'good' : u >= 98 ? 'warn' : 'bad';
const uptimeWord = (u: number | null) =>
  u === null ? 'sem dados' : u >= 99.9 ? 'excelente' : u >= 99.5 ? 'bom' : u >= 98 ? 'regular' : 'ruim';
function speed(ms: number | null): { word: string; tone: Tone; hint: string } {
  if (ms === null) return { word: 'sem dados', tone: 'none', hint: 'Não houve resposta para medir.' };
  if (ms < 500) return { word: 'rápido', tone: 'good', hint: 'Abre em menos de meio segundo.' };
  if (ms < 1500) return { word: 'aceitável', tone: 'warn', hint: 'O visitante já percebe a espera.' };
  return { word: 'lento', tone: 'bad', hint: 'Visitantes costumam desistir assim.' };
}
function securityInfo(score: number | null): { word: string; tone: Tone } {
  if (score === null) return { word: 'não auditado', tone: 'none' };
  if (score >= 90) return { word: 'bem protegido', tone: 'good' };
  return score >= 70
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
  if (s.avgResponseMs !== null && speed(s.avgResponseMs).tone !== 'good')
    out.push({
      tone: 'warn',
      text: 'Pedir uma revisão de desempenho (cache, imagens e hospedagem): o site está mais lento que o ideal.',
    });
  const serious = s.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  if (serious.length)
    out.push({
      tone: 'bad',
      text: `Corrigir ${serious.length} falha(s) de segurança grave(s), listadas abaixo.`,
    });
  else if (s.findings.length)
    out.push({
      tone: 'warn',
      text: `Pedir ao desenvolvedor os ajustes de segurança listados abaixo (${s.findings.length}).`,
    });
  if (out.length === 0)
    out.push({ tone: 'good', text: 'Nada urgente. Continue acompanhando no relatório do próximo mês.' });
  return out;
}

function compareLine(s: ReportSite, from: number): string | null {
  const prev = s.previous;
  const parts: string[] = [];
  const d0 = new Date(from);
  const prevMonth = new Date(d0.getFullYear(), d0.getMonth() - 1, 1).toLocaleDateString('pt-BR', {
    month: 'long',
  });
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

// ─── elementos de identidade ─────────────────────────────────────────────────

/** Gerador pseudoaleatório com semente: o desenho dos pixels é sempre o mesmo para o mesmo relatório. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Campo de quadradinhos em gelo, cada vez mais denso e claro em direção à base (como o fundo do painel). */
function pixelField(doc: Doc, x: number, y: number, w: number, h: number, seed: number, strength = 1) {
  const rand = rng(seed);
  const pitch = 6.4;
  const size = 2.2;
  for (let yy = 0; yy < h; yy += pitch) {
    const depth = (yy / h) ** 1.8;
    for (let xx = 0; xx < w; xx += pitch) {
      const n = rand();
      if (n > 0.1 + depth * 0.62) continue;
      // opacidade em degraus: poucos estados gráficos diferentes, arquivo bem menor
      const a = Math.round(Math.min(0.85, (0.06 + n * 0.25) * (0.35 + depth * 2.2) * strength) * 12) / 12;
      if (a <= 0) continue;
      doc
        .rect(x + xx, y + yy, size, size)
        .fillOpacity(a)
        .fill(C.ice);
    }
  }
  doc.fillOpacity(1);
}

function logo(doc: Doc, x: number, y: number, height: number, onDark: boolean) {
  const scale = height / BRAND.height;
  doc.save().translate(x, y).scale(scale);
  doc.path(BRAND.wordmark).fill(onDark ? '#f4f4f5' : C.ink);
  BRAND.arcs.forEach((d, i) => {
    doc
      .path(d)
      .lineWidth(2.3)
      .lineCap('round')
      .strokeOpacity(BRAND.arcOpacity[i])
      .strokeColor(onDark ? C.ice : C.iceDark)
      .stroke();
  });
  doc.restore();
  doc.strokeOpacity(1);
}

const square = (doc: Doc, x: number, y: number, size: number, color: string) =>
  doc.rect(x, y, size, size).fill(color);

function kicker(doc: Doc, text: string, x: number, y: number, color: string = C.iceDark, width = W) {
  doc
    .font(MD)
    .fontSize(7.4)
    .fillColor(color)
    .text(text.toUpperCase(), x, y, { width, characterSpacing: 1.4 });
}

/** Título de seção numerado: "02  Velocidade dia a dia". */
function section(doc: Doc, n: number, title: string, y: number, sub?: string) {
  doc
    .font(MD)
    .fontSize(8)
    .fillColor(C.iceDark)
    .text(String(n).padStart(2, '0'), M, y + 2.5, { lineBreak: false });
  doc
    .font(SB)
    .fontSize(12)
    .fillColor(C.ink)
    .text(title, M + 22, y, { width: W - 22 });
  let yy = doc.y + 1.5;
  if (sub) {
    doc
      .font(R)
      .fontSize(8.4)
      .fillColor(C.muted)
      .text(sub, M + 22, yy, { width: W - 22 });
    yy = doc.y;
  }
  return yy + 10;
}

/** Cabeçalho das páginas internas: marca, seção e período. */
function pageHeader(doc: Doc, part: string, data: ReportData) {
  logo(doc, M, 28, 16, false);
  doc
    .font(MD)
    .fontSize(7.2)
    .fillColor(C.faint)
    .text(`${part.toUpperCase()}  ·  ${periodLabel(data.from).toUpperCase()}`, M, 33, {
      width: W,
      align: 'right',
      characterSpacing: 1.2,
    });
  doc.rect(M, 54, W, 0.6).fill(C.rule);
  return 74;
}

function tag(doc: Doc, text: string, tone: Tone, xRight: number, y: number) {
  doc.font(MD).fontSize(8.6);
  const w = doc.widthOfString(text);
  square(doc, xRight - w - 12, y + 2.2, 6.5, TONE[tone]);
  doc.fillColor(TONE[tone]).text(text, xRight - w, y, { lineBreak: false });
}

// ─── capa ─────────────────────────────────────────────────────────────────

function cover(doc: Doc, data: ReportData) {
  doc.rect(0, 0, PW, PH).fill(C.night);
  pixelField(doc, 0, PH * 0.42, PW, PH * 0.58, data.from % 9973, 1.1);
  logo(doc, M, M, 30, true);
  // (o rótulo da capa fica acima do título, longe da logo)
  doc
    .font(R)
    .fontSize(7.4)
    .fillColor(C.muted)
    .text(periodLabel(data.from).toUpperCase(), M, M + 11, {
      width: W,
      align: 'right',
      characterSpacing: 1.4,
    });
  kicker(doc, 'Relatório mensal de monitoramento', M, 172, C.ice, W);
  doc
    .font(SB)
    .fontSize(30)
    .fillColor('#f4f4f5')
    .text(data.title, M, 190, { width: W * 0.86, lineGap: -2 });
  const by = [
    data.author ? `Preparado por ${data.author}` : null,
    `Gerado em ${new Date(data.generatedAt).toLocaleDateString('pt-BR')}`,
  ]
    .filter(Boolean)
    .join('   ·   ');
  doc
    .font(R)
    .fontSize(9.5)
    .fillColor(C.faint)
    .text(by, M, doc.y + 10, { width: W });

  // o número do mês
  const withData = data.sites.filter((s) => s.uptime !== null);
  const avg = withData.length ? withData.reduce((a, s) => a + (s.uptime ?? 0), 0) / withData.length : null;
  const incidents = data.sites.reduce((a, s) => a + s.incidents.length, 0);
  const down = data.sites.reduce((a, s) => a + s.downtimeMs, 0);
  const fast = withData.filter((s) => s.avgResponseMs !== null);
  const avgMs = fast.length
    ? Math.round(fast.reduce((a, s) => a + (s.avgResponseMs ?? 0), 0) / fast.length)
    : null;
  const y0 = 330;
  doc.rect(M, y0, 26, 2).fill(C.ice);
  doc
    .font(SB)
    .fontSize(66)
    .fillColor('#f4f4f5')
    .text(pct(avg), M - 3, y0 + 14, { lineBreak: false });
  const n = data.sites.length;
  doc
    .font(R)
    .fontSize(10.5)
    .fillColor(C.faint)
    .text(`do tempo no ar · ${n} site${n === 1 ? '' : 's'} monitorado${n === 1 ? '' : 's'}`, M, y0 + 92);
  const figs: [string, string][] = [
    ['Quedas', String(incidents)],
    ['Tempo fora do ar', formatDuration(down)],
    ['Resposta média', avgMs === null ? '—' : `${avgMs} ms`],
  ];
  const fw = W / 3;
  figs.forEach(([label, value], i) => {
    const x = M + i * fw;
    if (i) doc.rect(x - 12, y0 + 128, 0.6, 40).fill('#27303a');
    kicker(doc, label, x, y0 + 128, C.ice, fw - 20);
    doc
      .font(SB)
      .fontSize(21)
      .fillColor('#f4f4f5')
      .text(value, x, y0 + 142, { width: fw - 20, lineBreak: false });
  });

  // os sites do relatório, sobre os pixels
  const list = data.sites.slice(0, 8);
  const rowH = 21;
  const panelH = 34 + Math.max(1, list.length) * rowH;
  const py = PH - M - 30 - panelH;
  doc.rect(M, py, W, panelH).fillOpacity(0.88).fill(C.nightPanel).fillOpacity(1);
  doc.rect(M, py, W, 0.6).fill('#27303a');
  kicker(doc, 'Sites neste relatório', M + 16, py + 13, C.faint, W - 32);
  if (list.length === 0) {
    doc
      .font(R)
      .fontSize(9.5)
      .fillColor(C.faint)
      .text('Nenhum site selecionado.', M + 16, py + 31);
  }
  list.forEach((s, i) => {
    const y = py + 31 + i * rowH;
    const sit = situation(s);
    square(doc, M + 16, y + 3, 7, TONE[sit.tone]);
    doc
      .font(MD)
      .fontSize(10)
      .fillColor('#f4f4f5')
      .text(s.name, M + 32, y, { width: W * 0.5, lineBreak: false, ellipsis: true });
    doc
      .font(R)
      .fontSize(9)
      .fillColor(C.faint)
      .text(sit.word, M + W * 0.56, y + 1, { width: W * 0.2, lineBreak: false });
    doc
      .font(MD)
      .fontSize(10)
      .fillColor('#f4f4f5')
      .text(pct(s.uptime), M, y, { width: W - 16, align: 'right', lineBreak: false });
  });
  if (data.sites.length > list.length) {
    doc
      .font(R)
      .fontSize(8)
      .fillColor(C.muted)
      .text(`+ ${data.sites.length - list.length} site(s)`, M + 16, py + panelH - 14);
  }
  doc
    .font(R)
    .fontSize(7.5)
    .fillColor('#52525b')
    .text('uivo · monitoramento de sites', M, PH - M - 6, { lineBreak: false });
}

// ─── resumo ───────────────────────────────────────────────────────────────

function summaryPage(doc: Doc, data: ReportData) {
  doc.addPage();
  let y = pageHeader(doc, 'Resumo', data);
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

  y = section(doc, 1, 'Em uma frase', y);
  const headline =
    avg === null
      ? `Ainda não há dados de ${monthName(data.from)} para os sites escolhidos.`
      : `Em ${monthName(data.from)}, ${n === 1 ? 'seu site ficou' : `seus ${n} sites ficaram`} no ar ${pct(avg)} do tempo.`;
  doc
    .font(SB)
    .fontSize(17)
    .fillColor(C.ink)
    .text(headline, M + 22, y, { width: W - 22, lineGap: 1 });
  y = doc.y + 8;
  const slowest = fast[fast.length - 1];
  const bullets = [
    incidents
      ? `Houve ${incidents} queda${incidents > 1 ? 's' : ''}, somando ${formatDuration(down)} fora do ar.`
      : 'Nenhuma queda registrada no mês.',
    fast.length > 1 && fast[0].avgResponseMs !== slowest.avgResponseMs
      ? `Mais rápido: ${fast[0].name} (${fast[0].avgResponseMs} ms). Mais lento: ${slowest.name} (${slowest.avgResponseMs} ms).`
      : fast.length
        ? `Tempo médio de resposta: ${fast[0].avgResponseMs} ms (${speed(fast[0].avgResponseMs).word}).`
        : null,
    issues.length
      ? `${issues.length} ponto${issues.length > 1 ? 's pedem' : ' pede'} atenção (lista abaixo).`
      : 'Nada pedindo atenção: tudo dentro do esperado.',
  ].filter((b): b is string => b !== null);
  for (const b of bullets) {
    square(doc, M + 22, y + 4.5, 4, C.iceDark);
    doc
      .font(R)
      .fontSize(10)
      .fillColor(C.ink2)
      .text(b, M + 34, y, { width: W - 34 });
    y = doc.y + 4;
  }
  y += 18;

  y = section(doc, 2, 'Situação de cada site', y);
  const cols = [0.36, 0.17, 0.13, 0.1, 0.24].map((c) => c * (W - 22));
  const heads = ['Site', 'Situação', 'No ar', 'Quedas', 'Velocidade'];
  let x = M + 22;
  heads.forEach((h, i) => {
    doc
      .font(MD)
      .fontSize(7.2)
      .fillColor(C.faint)
      .text(h.toUpperCase(), x, y, { width: cols[i] - 6, characterSpacing: 1 });
    x += cols[i];
  });
  y += 15;
  for (const s of data.sites) {
    if (y > PH - 170) {
      doc.addPage();
      y = pageHeader(doc, 'Resumo', data);
    }
    doc.rect(M + 22, y - 5, W - 22, 0.5).fill(C.rule);
    const sit = situation(s);
    const sp = speed(s.avgResponseMs);
    x = M + 22;
    doc
      .font(MD)
      .fontSize(10)
      .fillColor(C.ink)
      .text(s.name, x, y, { width: cols[0] - 8, lineBreak: false, ellipsis: true });
    x += cols[0];
    square(doc, x, y + 2.6, 6.5, TONE[sit.tone]);
    doc
      .font(R)
      .fontSize(9.5)
      .fillColor(TONE[sit.tone])
      .text(sit.word, x + 11, y + 0.5, { width: cols[1] - 14, lineBreak: false });
    x += cols[1];
    doc
      .font(MD)
      .fillColor(C.ink)
      .text(pct(s.uptime), x, y + 0.5, { width: cols[2] - 6, lineBreak: false });
    x += cols[2];
    doc
      .fillColor(s.incidents.length ? C.red : C.ink)
      .text(String(s.incidents.length), x, y + 0.5, { width: cols[3] - 6, lineBreak: false });
    x += cols[3];
    doc
      .font(R)
      .fillColor(TONE[sp.tone])
      .text(s.avgResponseMs === null ? '—' : `${sp.word}, ${s.avgResponseMs} ms`, x, y + 0.5, {
        width: cols[4] - 6,
        lineBreak: false,
        ellipsis: true,
      });
    y += 22;
  }
  doc.rect(M + 22, y - 5, W - 22, 0.5).fill(C.rule);
  y += 20;

  if (issues.length) {
    y = section(doc, 3, 'Pontos de atenção', y);
    issues.slice(0, 8).forEach((it, i) => {
      if (y > PH - 110) return;
      doc
        .font(MD)
        .fontSize(8)
        .fillColor(TONE[it.tone])
        .text(String(i + 1).padStart(2, '0'), M + 22, y + 1.5, { lineBreak: false });
      doc
        .font(MD)
        .fontSize(9.6)
        .fillColor(C.ink)
        .text(`${it.site}  `, M + 44, y, { width: W - 44, continued: true });
      doc.font(R).fillColor(C.ink2).text(it.text);
      y = doc.y + 7;
    });
  }
  const partial = data.sites.filter((s) => s.coverage < 95 && s.checks > 0);
  if (partial.length && y < PH - 90) {
    doc
      .font(R)
      .fontSize(8)
      .fillColor(C.amber)
      .text(
        `Monitoramento parcial: ${partial.map((s) => `${s.name} (${String(s.coverage).replace('.', ',')}% do mês)`).join('; ')}. Os números valem só para o tempo em que o monitor esteve ligado.`,
        M + 22,
        y + 8,
        { width: W - 22 },
      );
  }
}

// ─── páginas de cada site ────────────────────────────────────────────────────

function siteTitle(doc: Doc, s: ReportSite, y: number) {
  doc
    .font(SB)
    .fontSize(22)
    .fillColor(C.ink)
    .text(s.name, M, y, { width: W - 130 });
  doc
    .font(R)
    .fontSize(8.6)
    .fillColor(C.muted)
    .text(s.url, M, doc.y + 1, { width: W - 130, link: s.url });
  const after = doc.y;
  const sit = situation(s);
  tag(doc, sit.word, sit.tone, M + W, y + 8);
  return after + 20;
}

/** Quatro números do mês, cada um com uma frase do que significa. */
function figures(doc: Doc, s: ReportSite, y: number) {
  const sp = speed(s.avgResponseMs);
  const sec = securityInfo(s.securityScore);
  const validity = Math.min(s.sslDays ?? 9999, s.domainDays ?? 9999);
  const vTone: Tone = validity === 9999 ? 'none' : validity <= 7 ? 'bad' : validity <= 30 ? 'warn' : 'good';
  const items: { label: string; value: string; word: string; tone: Tone; hint: string }[] = [
    {
      label: 'No ar',
      value: pct(s.uptime),
      word: uptimeWord(s.uptime),
      tone: uptimeTone(s.uptime),
      hint: s.downtimeMs ? `${formatDuration(s.downtimeMs)} fora do ar no mês.` : 'Nenhum minuto fora do ar.',
    },
    {
      label: 'Velocidade',
      value: s.avgResponseMs === null ? '—' : `${s.avgResponseMs} ms`,
      word: sp.word,
      tone: sp.tone,
      hint: sp.hint,
    },
    {
      label: 'Segurança',
      value: s.securityScore === null ? '—' : `${s.securityScore}/100`,
      word: sec.word,
      tone: sec.tone,
      hint: s.findings.length ? `${s.findings.length} ajuste(s) na próxima página.` : 'Nada a corrigir.',
    },
    {
      label: 'Próximo vencimento',
      value: validity === 9999 ? '—' : validity < 0 ? 'vencido' : `${validity} dias`,
      word: vTone === 'good' ? 'em dia' : vTone === 'none' ? 'não verificado' : 'renovar logo',
      tone: vTone,
      hint: 'Certificado SSL ou domínio.',
    },
  ];
  const cw = (W - 3 * 14) / 4;
  items.forEach((it, i) => {
    const x = M + i * (cw + 14);
    doc.rect(x, y, cw, 0.6).fill(C.rule);
    doc.rect(x, y - 0.7, 22, 2).fill(TONE[it.tone]);
    kicker(doc, it.label, x, y + 10, C.faint, cw);
    let size = 21;
    doc.font(SB);
    while (size > 12 && doc.fontSize(size).widthOfString(it.value) > cw) size -= 1;
    doc
      .fontSize(size)
      .fillColor(C.ink)
      .text(it.value, x, y + 23, { width: cw, lineBreak: false });
    doc
      .font(MD)
      .fontSize(8.6)
      .fillColor(TONE[it.tone])
      .text(it.word, x, y + 50, { width: cw });
    doc
      .font(R)
      .fontSize(7.8)
      .fillColor(C.muted)
      .text(it.hint, x, doc.y + 1.5, { width: cw });
  });
  return y + 96;
}

function legend(doc: Doc, y: number, items: [string, string][]) {
  let x = M;
  doc.font(R).fontSize(7);
  for (const [color, text] of items) {
    square(doc, x, y + 1.3, 5.5, color);
    doc.fillColor(C.muted).text(text, x + 9, y, { lineBreak: false });
    x += 9 + doc.widthOfString(text) + 16;
  }
}

/** Um quadradinho por dia, como as 24 h do painel. */
function dayGrid(doc: Doc, s: ReportSite, y: number) {
  const n = s.daily.length;
  const gap = 3;
  const size = Math.min(16, (W - gap * (n - 1)) / n);
  s.daily.forEach((u, i) => {
    square(doc, M + i * (size + gap), y, size, u === null ? C.empty : TONE[uptimeTone(u)]);
  });
  doc.font(R).fontSize(6.8).fillColor(C.faint);
  s.daily.forEach((_, i) => {
    if (i === 0 || (i + 1) % 5 === 0 || i === n - 1)
      doc.text(String(i + 1), M + i * (size + gap) - 3, y + size + 4, { width: size + 6, align: 'center' });
  });
  legend(doc, y + size + 18, [
    [C.green, 'no ar o dia todo'],
    [C.amber, 'instabilidade'],
    [C.red, 'fora do ar por bastante tempo'],
    [C.empty, 'sem monitoramento'],
  ]);
  return y + size + 34;
}

/** Velocidade dia a dia: linha em gelo sobre faixas de rápido / aceitável / lento. */
function speedChart(doc: Doc, s: ReportSite, y: number) {
  const H = 96;
  const left = M + 36;
  const cw = W - 36;
  const values = s.dailyMs.filter((v): v is number => v !== null);
  const top = Math.max(800, Math.ceil((Math.max(0, ...values) * 1.25) / 200) * 200);
  const yOf = (ms: number) => y + H - (Math.min(ms, top) / top) * H;
  const bands: [number, number, string][] = [
    [0, 500, '#f0fdf4'],
    [500, 1500, '#fffbeb'],
    [1500, top, '#fef2f2'],
  ];
  for (const [a, b, color] of bands) {
    if (a >= top) continue;
    doc.rect(left, yOf(Math.min(b, top)), cw, yOf(a) - yOf(Math.min(b, top))).fill(color);
  }
  doc.font(R).fontSize(6.8).fillColor(C.faint);
  for (const v of [0, top / 2, top]) {
    doc.text(`${Math.round(v)} ms`, M - 6, yOf(v) - 3, { width: 36, align: 'right' });
    doc.rect(left, yOf(v), cw, 0.4).fill(C.rule);
  }
  const n = s.dailyMs.length;
  const xOf = (i: number) => left + (n === 1 ? cw / 2 : (i / (n - 1)) * cw);
  // área sob a linha e a linha, com quebras nos dias sem dados
  const runs: number[][] = [];
  let cur: number[] = [];
  s.dailyMs.forEach((v, i) => {
    if (v === null) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push(i);
  });
  if (cur.length) runs.push(cur);
  for (const run of runs) {
    doc.moveTo(xOf(run[0]), y + H);
    for (const i of run) doc.lineTo(xOf(i), yOf(s.dailyMs[i] ?? 0));
    doc
      .lineTo(xOf(run[run.length - 1]), y + H)
      .closePath()
      .fillOpacity(0.14)
      .fill(C.iceDark)
      .fillOpacity(1);
    doc.moveTo(xOf(run[0]), yOf(s.dailyMs[run[0]] ?? 0));
    for (const i of run) doc.lineTo(xOf(i), yOf(s.dailyMs[i] ?? 0));
    doc.lineWidth(1.5).lineJoin('round').strokeColor(C.iceDark).stroke();
  }
  doc.font(R).fontSize(6.8).fillColor(C.faint);
  s.dailyMs.forEach((_, i) => {
    if (i === 0 || (i + 1) % 5 === 0 || i === n - 1)
      doc.text(String(i + 1), xOf(i) - 6, y + H + 4, { width: 12, align: 'center' });
  });
  legend(doc, y + H + 18, [
    ['#bbf7d0', 'rápido (até 0,5 s)'],
    ['#fde68a', 'aceitável (até 1,5 s)'],
    ['#fecaca', 'lento'],
    [C.iceDark, 'tempo médio do dia'],
  ]);
  return y + H + 34;
}

/** 24 quadradinhos, um por hora do dia: quanto mais escuro, mais lento; as 3 piores em âmbar. */
function hourStrip(doc: Doc, s: ReportSite, y: number) {
  const valid = s.hourlyMs.filter((v): v is number => v !== null);
  if (valid.length < 6) {
    doc
      .font(R)
      .fontSize(9)
      .fillColor(C.muted)
      .text('Ainda não há dados suficientes para comparar os horários.', M, y);
    return doc.y + 10;
  }
  const max = Math.max(...valid);
  const min = Math.min(...valid);
  const gap = 3;
  const size = (W - gap * 23) / 24;
  const slowest = [...s.hourlyMs.entries()]
    .filter(([, v]) => v !== null)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 3)
    .map(([h]) => h);
  const shades = ['#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0ea5e9', '#0284c7'];
  s.hourlyMs.forEach((v, h) => {
    const x = M + h * (size + gap);
    if (v === null) {
      square(doc, x, y, size, C.empty);
      return;
    }
    const k = Math.round(((v - min) / Math.max(1, max - min)) * (shades.length - 1));
    square(doc, x, y, size, slowest.includes(h) ? C.amber : shades[k]);
  });
  doc.font(R).fontSize(6.8).fillColor(C.faint);
  for (let h = 0; h < 24; h += 3)
    doc.text(`${h}h`, M + h * (size + gap) - 2, y + size + 4, { width: size + 4, align: 'center' });
  const hours = [...slowest].sort((a, b) => a - b).map((h) => `${h}h`);
  const avgSlow = Math.round(slowest.reduce((a, h) => a + (s.hourlyMs[h] ?? 0), 0) / slowest.length);
  doc
    .font(MD)
    .fontSize(9.2)
    .fillColor(C.ink)
    .text(`Mais lento às ${hours.join(', ')}: média de ${avgSlow} ms. `, M, y + size + 20, {
      width: W,
      continued: true,
    })
    .font(R)
    .fillColor(C.ink2)
    .text(
      max - min < 80
        ? 'A diferença ao longo do dia é pequena: o site se comporta bem em qualquer horário.'
        : 'Costumam ser os horários de mais movimento; se for o seu pico de vendas, vale melhorar a hospedagem.',
    );
  return doc.y + 10;
}

function siteOverview(doc: Doc, data: ReportData, s: ReportSite) {
  doc.addPage();
  let y = pageHeader(doc, 'Visão geral do site', data);
  y = siteTitle(doc, s, y);
  y = figures(doc, s, y);
  const cmp = compareLine(s, data.from);
  if (cmp) {
    doc.rect(M, y, W, 26).fill(C.wash);
    doc.rect(M, y, 2, 26).fill(C.iceDark);
    doc
      .font(R)
      .fontSize(9)
      .fillColor(C.ink2)
      .text(cmp, M + 12, y + 8.5, { width: W - 20, lineBreak: false, ellipsis: true });
    y += 38;
  }
  if (s.coverage < 95 && s.checks > 0) {
    doc
      .font(R)
      .fontSize(8)
      .fillColor(C.amber)
      .text(
        `Monitorado em ${String(s.coverage).replace('.', ',')}% do mês: os números valem só para esse período.`,
        M,
        y,
        {
          width: W,
        },
      );
    y = doc.y + 8;
  }
  y += 6;
  y = section(doc, 1, 'Disponibilidade dia a dia', y, 'Cada quadrado é um dia do mês.');
  y = dayGrid(doc, s, y);
  y += 4;
  y = section(
    doc,
    2,
    'Velocidade dia a dia',
    y,
    'Tempo médio de resposta em cada dia. Quanto mais baixo, melhor.',
  );
  y = speedChart(doc, s, y);
  y += 4;
  y = section(doc, 3, 'Horários mais lentos', y, 'Cada quadrado é uma hora do dia, somando o mês todo.');
  hourStrip(doc, s, y);
}

function incidentRow(doc: Doc, inc: ReportIncident, y: number) {
  doc.rect(M + 22, y - 5, W - 22, 0.5).fill(C.rule);
  square(doc, M + 22, y + 2.5, 6, inc.end ? C.red : C.amber);
  doc
    .font(MD)
    .fontSize(9.2)
    .fillColor(C.ink)
    .text(dateTime(inc.start), M + 34, y, { width: 120, lineBreak: false });
  doc
    .font(R)
    .fillColor(C.ink)
    .text(inc.end ? `${formatDuration(inc.durationMs)} fora do ar` : 'ainda fora do ar', M + 158, y, {
      width: 110,
      lineBreak: false,
    });
  doc.fillColor(C.muted).text(plainReason(inc.reason), M + 272, y, { width: W - 272 });
  return Math.max(doc.y, y + 12) + 9;
}

const SEV_WORD: Record<Severity, { word: string; tone: Tone }> = {
  critical: { word: 'Urgente', tone: 'bad' },
  high: { word: 'Importante', tone: 'bad' },
  medium: { word: 'Recomendado', tone: 'warn' },
  low: { word: 'Opcional', tone: 'none' },
};

function siteDetails(doc: Doc, data: ReportData, s: ReportSite) {
  doc.addPage();
  let y = pageHeader(doc, 'Próximos passos', data);
  y = siteTitle(doc, s, y);

  y = section(doc, 4, 'O que fazer agora', y);
  todo(s).forEach((t, i) => {
    doc
      .rect(M + 22, y - 1, 16, 16)
      .lineWidth(0.8)
      .strokeColor(TONE[t.tone])
      .stroke();
    doc
      .font(MD)
      .fontSize(7.5)
      .fillColor(TONE[t.tone])
      .text(String(i + 1), M + 22, y + 3.5, { width: 16, align: 'center' });
    doc
      .font(R)
      .fontSize(9.8)
      .fillColor(C.ink)
      .text(t.text, M + 48, y + 1, { width: W - 48 });
    y = Math.max(doc.y, y + 16) + 9;
  });
  y += 12;

  y = section(
    doc,
    5,
    `Quedas no mês (${s.incidents.length})`,
    y,
    s.incidents.length ? 'Quando o site ficou fora do ar, por quanto tempo e por quê.' : undefined,
  );
  if (s.incidents.length === 0) {
    doc
      .font(R)
      .fontSize(9.8)
      .fillColor(C.green)
      .text('Nenhuma queda: o site respondeu o mês inteiro.', M + 22, y);
    y = doc.y + 20;
  } else {
    for (const inc of s.incidents.slice(0, 10)) y = incidentRow(doc, inc, y);
    doc.rect(M + 22, y - 5, W - 22, 0.5).fill(C.rule);
    if (s.incidents.length > 10) {
      doc
        .font(R)
        .fontSize(8)
        .fillColor(C.muted)
        .text(`+ ${s.incidents.length - 10} queda(s) no período`, M + 22, y);
      y = doc.y + 4;
    }
    y += 14;
  }

  y = section(
    doc,
    6,
    'Segurança: o que pedir ao desenvolvedor',
    y,
    s.findings.length ? 'Pode encaminhar esta lista: cada item já diz o que ajustar.' : undefined,
  );
  if (s.securityScore === null) {
    doc
      .font(R)
      .fontSize(9.8)
      .fillColor(C.muted)
      .text('O site ainda não foi auditado.', M + 22, y);
    y = doc.y + 20;
  } else if (s.findings.length === 0) {
    doc
      .font(R)
      .fontSize(9.8)
      .fillColor(C.green)
      .text('Nenhum problema encontrado na última verificação.', M + 22, y);
    y = doc.y + 20;
  } else {
    const order: Severity[] = ['critical', 'high', 'medium', 'low'];
    for (const f of [...s.findings]
      .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
      .slice(0, 6)) {
      if (y > PH - 130) break;
      const sev = SEV_WORD[f.severity];
      square(doc, M + 22, y + 3, 6, TONE[sev.tone]);
      doc
        .font(MD)
        .fontSize(7.2)
        .fillColor(TONE[sev.tone])
        .text(sev.word.toUpperCase(), M + 34, y + 2, { width: 80, characterSpacing: 0.8, lineBreak: false });
      doc
        .font(MD)
        .fontSize(9.8)
        .fillColor(C.ink)
        .text(f.title, M + 118, y, { width: W - 118 });
      if (f.fix)
        doc
          .font(R)
          .fontSize(8.6)
          .fillColor(C.muted)
          .text(f.fix, M + 118, doc.y + 1.5, { width: W - 118 });
      y = doc.y + 11;
    }
    y += 6;
  }

  if (y < PH - 120) {
    y = section(doc, 7, 'Vencimentos', y);
    const row = (name: string, days: number | null, what: string) => {
      const tone: Tone = days === null ? 'none' : days <= 7 ? 'bad' : days <= 30 ? 'warn' : 'good';
      doc.rect(M + 22, y - 5, W - 22, 0.5).fill(C.rule);
      square(doc, M + 22, y + 2.5, 6, TONE[tone]);
      doc
        .font(MD)
        .fontSize(9.6)
        .fillColor(C.ink)
        .text(name, M + 34, y, { width: 120, lineBreak: false });
      doc
        .font(R)
        .fillColor(TONE[tone])
        .text(days === null ? 'não verificado' : days < 0 ? 'vencido' : `vence em ${days} dias`, M + 158, y, {
          width: 110,
          lineBreak: false,
        });
      doc.fillColor(C.muted).text(what, M + 272, y, { width: W - 272 });
      y = Math.max(doc.y, y + 12) + 9;
    };
    row(
      'Certificado SSL',
      s.sslDays,
      'O "cadeado" do navegador. Sem ele, aparece o aviso "site não seguro".',
    );
    row(
      'Domínio',
      s.domainDays,
      'O endereço do site. Se vencer, o site sai do ar e o nome pode ser perdido.',
    );
    doc.rect(M + 22, y - 5, W - 22, 0.5).fill(C.rule);
  }
}

// ─── glossário ─────────────────────────────────────────────────────────────

function glossary(doc: Doc, data: ReportData) {
  doc.addPage();
  let y = pageHeader(doc, 'Glossário', data);
  doc.font(SB).fontSize(22).fillColor(C.ink).text('Como ler este relatório', M, y);
  y = doc.y + 22;
  const items: [string, string][] = [
    [
      'No ar (disponibilidade)',
      'Porcentagem do tempo em que o site abriu normalmente. 99,5% parece muito, mas ainda são cerca de 3 horas e meia fora do ar num mês; acima de 99,9% é excelente.',
    ],
    [
      'Queda',
      'Período em que o site não abriu. Só conta como queda depois de duas tentativas seguidas sem resposta, para evitar alarme falso.',
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
  items.forEach(([term, text], i) => {
    doc
      .font(MD)
      .fontSize(8)
      .fillColor(C.iceDark)
      .text(String(i + 1).padStart(2, '0'), M, y + 2, { lineBreak: false });
    doc
      .font(SB)
      .fontSize(11)
      .fillColor(C.ink)
      .text(term, M + 26, y);
    doc
      .font(R)
      .fontSize(9.4)
      .fillColor(C.ink2)
      .text(text, M + 26, doc.y + 3, { width: W - 26, lineGap: 1.6 });
    y = doc.y + 16;
  });
  doc
    .font(R)
    .fontSize(8.4)
    .fillColor(C.faint)
    .text(
      'Os dados vêm de checagens automáticas feitas de fora do site, como um visitante faria, várias vezes por hora.',
      M + 26,
      y + 6,
      { width: W - 26 },
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
    doc.registerFont(R, path.join(FONTS, 'Geist-Regular.ttf'));
    doc.registerFont(MD, path.join(FONTS, 'Geist-Medium.ttf'));
    doc.registerFont(SB, path.join(FONTS, 'Geist-SemiBold.ttf'));
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    cover(doc, data);
    summaryPage(doc, data);
    for (const s of data.sites) {
      siteOverview(doc, data, s);
      siteDetails(doc, data, s);
    }
    glossary(doc, data);

    // Rodapé das páginas internas (a capa não tem)
    const range = doc.bufferedPageRange();
    for (let i = range.start + 1; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // o rodapé fica abaixo da margem: sem zerá-la, o pdfkit criaria uma página nova para ele
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = PH - 30;
      doc.rect(M, y - 9, W, 0.5).fill(C.rule);
      doc
        .font(R)
        .fontSize(7.2)
        .fillColor(C.faint)
        .text(`${data.title}  ·  ${periodLabel(data.from)}`, M, y, { lineBreak: false })
        .text(`${i - range.start + 1} / ${range.count}`, M, y, {
          width: W,
          align: 'right',
          lineBreak: false,
        });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}
