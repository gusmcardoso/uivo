import { BRAND } from '../../shared/brand.ts';

export function Logo() {
  return (
    <svg
      viewBox={`0 0 ${BRAND.width} ${BRAND.height}`}
      className="h-9 w-auto text-zinc-200"
      role="img"
      aria-label="Uivo"
    >
      <path d={BRAND.moon} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <path
        d={BRAND.pulse}
        fill="none"
        stroke={BRAND.amber.onDark}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d={BRAND.wordmark} fill="currentColor" />
    </svg>
  );
}
