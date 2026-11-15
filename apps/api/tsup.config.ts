import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle the TypeScript-source workspace packages; keep npm deps external.
  noExternal: [/^@vamos\//],
  // The npm deps of bundled workspace packages are bundled too (cheerio from @vamos/scraper,
  // and with it iconv-lite), and their CommonJS code calls require() on Node built-ins.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
