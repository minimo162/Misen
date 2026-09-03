import { build } from 'esbuild'
import tailwindcss from '@tailwindcss/postcss'
import postcss from 'postcss'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(resolve(appRoot, 'dist/web/assets'), { recursive: true })
const tailwindPlugin = {
  name: 'misen-tailwind',
  setup(builder) {
    builder.onLoad({ filter: /src[\\/]web[\\/]client\.css$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8')
      const result = await postcss([tailwindcss()]).process(source, { from: path })
      return { contents: result.css, loader: 'css', resolveDir: dirname(path) }
    })
  },
}
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
  plugins: [tailwindPlugin],
})
