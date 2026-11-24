import { createRequire } from 'node:module';
import path from 'node:path';
import { BRAND } from '../shared/brand.ts';

/*
 * Selo "monitorado com uivo" para colar no rodapé de qualquer site: um SVG com o status ao
 * vivo e o uptime de 30 dias. O texto vira curva aqui no servidor (fonte Geist), então o selo
 * fica igual em qualquer navegador, sem depender de fonte instalada.
 */

interface Glyph {
  path: { scale(x: number, y: number): { translate(x: number, y: number): { toSVG(): string } } };
}
interface Font {
  unitsPerEm: number;
  layout(text: string): { glyphs: Glyph[]; positions: { xAdvance: number }[] };
}
const fontkit = createRequire(import.meta.url)('fontkit') as { openSync(file: string): Font };
const FONTS = path.join(import.meta.dirname, 'report', 'fonts');
let fonts: { regular: Font; medium: Font } | null = null;
const loadFonts = () => {
  fonts ??= {
    regular: fontkit.openSync(path.join(FONTS, 'Geist-Regular.ttf')),
    medium: fontkit.openSync(path.join(FONTS, 'Geist-Medium.ttf')),
  };
  return fonts;
};

/** Texto em curvas: devolve o path e a largura. */
function text(font: Font, value: string, size: number, x: number, baseline: number) {
  const scale = size / font.unitsPerEm;
  let cx = 0;
  const run = font.layout(value);
  const d = run.glyphs
    .map((g, i) => {
      const p = g.path
        .scale(scale, -scale)
        .translate(x + cx, baseline)
        .toSVG();
      cx += run.positions[i].xAdvance * scale;
      return p;
    })
    .join('')
    .replace(/(\d+\.\d{2})\d+/g, '$1');
  return { d, width: cx };
}

const escapeXml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

export interface BadgeInput {
  name: string;
  status: 'up' | 'down' | 'unknown';
  /** uptime de 30 dias, em % */
  uptime: number | null;
  theme: 'escuro' | 'claro';
}

const THEMES = {
  escuro: {
    bg: '#0c0f13',
    border: '#27272a',
    label: '#a1a1aa',
    value: '#f4f4f5',
    mark: '#f4f4f5',
    arcs: BRAND.ice.onDark,
  },
  claro: {
    bg: '#ffffff',
    border: '#e4e4e7',
    label: '#52525b',
    value: '#18181b',
    mark: '#18181b',
    arcs: BRAND.ice.onLight,
  },
};
const DOT = { up: '#10b981', down: '#ef4444', unknown: '#71717a' };

export function renderBadge(b: BadgeInput): string {
  const { regular, medium } = loadFonts();
  const t = THEMES[b.theme];
  const H = 24;
  const size = 10.5;
  const base = 15.6;
  let x = 22;
  const label = text(regular, 'monitorado com', size, x, base);
  x += label.width + 4.5;
  // a marca: "uivo" e o eco, na altura do texto
  const markScale = 12.5 / BRAND.height;
  const markX = x;
  const markY = 12 - (BRAND.height * markScale) / 2 + 0.4;
  x += BRAND.width * markScale + 7;
  const sep = text(regular, '·', size, x, base);
  x += sep.width + 5;
  const valueText =
    b.status === 'down'
      ? 'fora do ar'
      : b.uptime === null
        ? 'sem dados'
        : b.uptime >= 100
          ? '100%'
          : `${b.uptime.toFixed(2).replace('.', ',')}%`;
  const value = text(medium, valueText, size, x, base);
  const W = Math.ceil(x + value.width + 10);
  const valueColor = b.status === 'down' ? DOT.down : t.value;
  const title =
    b.status === 'down'
      ? `${b.name}: fora do ar · monitorado com Uivo`
      : `${b.name}: ${b.status === 'up' ? 'no ar' : 'aguardando'}${b.uptime === null ? '' : ` · ${valueText} em 30 dias`} · monitorado com Uivo`;
  // o ponto de status pulsa devagar quando o site está no ar
  const pulse =
    b.status === 'up'
      ? `<circle cx="12" cy="12" r="3.5" fill="${DOT.up}" opacity="0.5"><animate attributeName="r" values="3.5;7;3.5" dur="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.5;0;0.5" dur="2.4s" repeatCount="indefinite"/></circle>`
      : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeXml(title)}"><title>${escapeXml(title)}</title><rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="4" fill="${t.bg}" stroke="${t.border}"/>${pulse}<circle cx="12" cy="12" r="3.5" fill="${DOT[b.status]}"/><path d="${label.d}" fill="${t.label}"/><g transform="translate(${markX.toFixed(2)} ${markY.toFixed(2)}) scale(${markScale.toFixed(4)})"><path d="${BRAND.wordmark}" fill="${t.mark}"/>${BRAND.arcs
    .map(
      (d, i) =>
        `<path d="${d}" fill="none" stroke="${t.arcs}" stroke-width="2.6" stroke-linecap="round" opacity="${BRAND.arcOpacity[i]}"/>`,
    )
    .join('')}</g><path d="${sep.d}" fill="${t.label}"/><path d="${value.d}" fill="${valueColor}"/></svg>`;
}
