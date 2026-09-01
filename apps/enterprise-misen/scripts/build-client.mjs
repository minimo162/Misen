import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(resolve(appRoot, 'dist/web/assets'), { recursive: true })
await build({
  absWorkingDir: appRoot,
  entryPoints: [resolve(appRoot, 'src/web/client.tsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  outfile: resolve(appRoot, 'dist/web/assets/client.js'),
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  sourcemap: false,
  minify: true,
})
