import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
) as { version: string };

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, 'manifest.json'), 'utf8'),
) as Record<string, unknown>;

export default defineConfig({
  publicDir: 'public',
  plugins: [
    {
      name: 'sync-extension-manifest-version',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'manifest.json',
          source: `${JSON.stringify(
            {
              ...manifest,
              version: packageJson.version,
            },
            null,
            2,
          )}\n`,
        });
      },
    },
    viteStaticCopy({
      targets: [
        {
          src: 'options.html',
          dest: '.',
        },
      ],
    }),
  ],
  build: {
    outDir: 'dist',
    emptyDirOnce: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        'content/trace': resolve(__dirname, 'src/content/trace.ts'),
        options: resolve(__dirname, 'src/options.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        format: 'es',
      },
    },
    target: 'esnext',
    minify: false,
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
