import { BRAND } from '../../shared/brand.ts';

export function Logo({ className = 'h-8' }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${BRAND.width} ${BRAND.height}`}
      className={`${className} w-auto text-zinc-100`}
      role="img"
      aria-label="Uivo"
    >
      <path d={BRAND.wordmark} fill="currentColor" />
      {BRAND.arcs.map((d, i) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke={BRAND.ice.onDark}
          strokeWidth="2.4"
          strokeLinecap="round"
          opacity={BRAND.arcOpacity[i]}
        />
      ))}
    </svg>
  );
}
