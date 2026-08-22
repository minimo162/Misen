import { build } from 'esbuild'

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info'
}

await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' })
await build({ ...common, entryPoints: ['test/smoke.ts'], outfile: 'dist/smoke.js' })
