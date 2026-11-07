import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

const pages = ['home', 'index', 'admin', 'tournament', 'calendar', 'notice', 'policy'];

// 개발 중에는 vite(5173)가 화면을, 실제 서버(3000)가 API를 맡는다. 서버의 쪽 주소(/terms 등)도 같은 방식으로 넘긴다.
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(root, `web/${p}.html`)])) },
  },
  server: {
    proxy: Object.fromEntries(['/api', '/auth', '/banner'].map((p) => [p, 'http://localhost:3000'])),
  },
});
