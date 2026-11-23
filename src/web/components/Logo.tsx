export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="size-8" aria-hidden="true">
        <circle cx="16" cy="16" r="14" className="fill-emerald-500" />
        <path
          d="M6 17h6l3-7 4 13 3-6h4"
          className="stroke-emerald-950"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="text-lg font-semibold tracking-tight">
        Up<span className="text-emerald-400">true</span>
      </span>
    </div>
  );
}
