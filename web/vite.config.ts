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
  // 只构建 index.html（App 本身）。「相亲物语」2026-11-27 先不上：wuyu.html 和 src/wuyu/ 留在仓库里，不打包、不部署。
  // 要加回来：input 里加 wuyu: here('./wuyu.html')（单独一页，three.js 只打进这一页）
  build: { outDir: 'dist', rollupOptions: { input: { main: here('./index.html') } } },
});
