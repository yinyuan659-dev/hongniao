import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': { target: 'https://api.yyheart.com', changeOrigin: true },
      '/ws': { target: 'wss://api.yyheart.com', ws: true },
      '/res': { target: 'https://api.yyheart.com', changeOrigin: true },
    },
  },
  // 两个网页：index.html 是 App 本身；wuyu.html 是大厅里的「相亲物语」（单独一页，three.js 只打进这一页）
  build: { outDir: 'dist', rollupOptions: { input: { main: here('./index.html'), wuyu: here('./wuyu.html') } } },
});
