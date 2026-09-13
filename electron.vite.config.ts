import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'out/main' },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@platform': resolve('src/platform'),
        // 必须与 tsconfig.json / vitest.config.ts 一致，否则 main 侧写 '@kernel/...' 会构建失败
        '@kernel': resolve('src/text-kernel'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'out/preload' },
    // 预加载脚本极薄，暂不需要别名；若将来用到请同步 tsconfig
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: { outDir: 'out/renderer' },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@kernel': resolve('src/text-kernel'),
      },
    },
  },
});
