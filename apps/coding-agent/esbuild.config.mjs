import { build } from 'esbuild'

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info'
}

const browser = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  sourcemap: false,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' }
}

await build({ ...common, entryPoints: ['./src/index.ts'], outfile: 'dist/index.js' })
await build({ ...common, entryPoints: ['./src/server.ts'], outfile: 'dist/server.js' })
await build({ ...common, entryPoints: ['./src/openai-bridge-server.ts'], outfile: 'dist/openai-bridge.js' })
await build({ ...common, entryPoints: ['./test/smoke.ts'], outfile: 'dist/smoke.js' })
await build({ ...common, entryPoints: ['./test/flex-harness.ts'], outfile: 'dist/flex-harness.js' })
await build({ ...common, entryPoints: ['./src/benchmark-cli.ts'], outfile: 'dist/benchmark.js' })
await build({ ...common, entryPoints: ['./test/benchmark.ts'], outfile: 'dist/benchmark-test.js' })
await build({ ...browser, entryPoints: ['./src/ui/main.ts'], outfile: 'dist/ui.js' })
