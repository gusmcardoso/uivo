import { useEffect, useRef } from 'react';

const PITCH = 6; // distância entre quadradinhos
const SIZE = 2; // lado de cada quadradinho
const ICE = '125, 211, 252';

/**
 * Fundo de "terminal": gradiente do escuro (topo) para o gelo (base), feito de quadradinhos
 * minúsculos que acendem e apagam devagar. Fica atrás de tudo e não recebe cliques.
 * Com "reduzir movimento" ligado no sistema, fica parado.
 */
export function PixelBackground() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let cols = 0;
    let rows = 0;
    let base = new Float32Array(0);
    let glow = new Float32Array(0);
    let timer = 0;

    const alphaAt = (i: number) => Math.min(0.55, base[i] + glow[i]);
    const paint = (i: number) => {
      const x = (i % cols) * PITCH;
      const y = Math.floor(i / cols) * PITCH;
      ctx.clearRect(x, y, SIZE, SIZE);
      const a = alphaAt(i);
      if (a > 0.004) {
        ctx.fillStyle = `rgba(${ICE}, ${a.toFixed(3)})`;
        ctx.fillRect(x, y, SIZE, SIZE);
      }
    };

    const setup = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.ceil(w * dpr);
      canvas.height = Math.ceil(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / PITCH);
      rows = Math.ceil(h / PITCH);
      base = new Float32Array(cols * rows);
      glow = new Float32Array(cols * rows);
      for (let r = 0; r < rows; r++) {
        // quanto mais para baixo, mais quadradinhos e mais claros (escuro → claro)
        const depth = (r / rows) ** 2.2;
        for (let c = 0; c < cols; c++) {
          const n = Math.random();
          base[r * cols + c] = n < 0.18 + depth * 0.5 ? (0.02 + n * 0.07) * (0.3 + depth * 1.9) : 0;
        }
      }
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < base.length; i++) paint(i);
    };

    setup();
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!still) {
      // a cada passo, alguns quadradinhos acendem (mais na parte de baixo) e os acesos apagam devagar
      timer = window.setInterval(() => {
        for (let k = 0; k < 14; k++) {
          const r = Math.floor(rows * (1 - Math.random() ** 1.8));
          const i = r * cols + Math.floor(Math.random() * cols);
          if (i < glow.length) glow[i] = 0.12 + Math.random() * 0.2;
        }
        for (let i = 0; i < glow.length; i++) {
          if (glow[i] > 0) {
            glow[i] = glow[i] < 0.01 ? 0 : glow[i] * 0.86;
            paint(i);
          }
        }
      }, 90);
    }
    let resizeTimer = 0;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(setup, 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearInterval(timer);
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <>
      <div
        className="pointer-events-none fixed inset-0 -z-20"
        style={{ background: 'linear-gradient(180deg, #040506 0%, #06090d 45%, #0a1822 100%)' }}
        aria-hidden="true"
      />
      <div className="pointer-events-none fixed inset-0 -z-10" aria-hidden="true">
        <canvas ref={ref} />
      </div>
    </>
  );
}
