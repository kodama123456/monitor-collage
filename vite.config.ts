import { defineConfig } from 'vite';

// GitHub Pages（https://<user>.github.io/<repo>/）でも動くよう相対パスで出力
export default defineConfig({
  base: './',
  build: { target: 'es2020', assetsInlineLimit: 0 },
  server: { fs: { allow: ['.'] } },
});
