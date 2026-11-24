import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    // fontes nunca embutidas como data: (a CSP só libera arquivos do próprio servidor)
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
  },
  server: { proxy: { '/api': 'http://127.0.0.1:3000', '/healthz': 'http://127.0.0.1:3000' } },
});
