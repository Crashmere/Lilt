import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/lilt/',
  plugins: [react()],
  server: { port: 5189, proxy: { '/lilt/api': 'http://127.0.0.1:18089' } },
  build: { target: 'es2022', sourcemap: false },
});
