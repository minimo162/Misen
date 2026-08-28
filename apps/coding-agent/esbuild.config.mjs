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

// Test/live harnesses run beside an npm installation, so keep third-party
// packages external instead of duplicating the AI SDK into every test bundle.
const testCommon = { ...common, external: ['ai', '@ai-sdk/*'] }

await build({ ...common, entryPoints: ['./src/index.ts'], outfile: 'dist/index.js' })
await build({ ...common, entryPoints: ['./src/server.ts'], outfile: 'dist/server.js' })
await build({ ...common, entryPoints: ['./src/openai-bridge-server.ts'], outfile: 'dist/openai-bridge.js' })
await build({ ...common, entryPoints: ['./test/smoke.ts'], outfile: 'dist/smoke.js' })
await build({ ...common, entryPoints: ['./test/flex-harness.ts'], outfile: 'dist/flex-harness.js' })
await build({ ...common, entryPoints: ['./src/benchmark-cli.ts'], outfile: 'dist/benchmark.js' })
await build({ ...common, entryPoints: ['./test/benchmark.ts'], outfile: 'dist/benchmark-test.js' })
await build({ ...testCommon, entryPoints: ['./test/multimodal.ts'], outfile: 'dist/multimodal-test.js' })
await build({ ...testCommon, entryPoints: ['./test/computer-use-demo.ts'], outfile: 'dist/computer-use-demo-test.js' })
await build({ ...testCommon, entryPoints: ['./test/computer-use-safety.ts'], outfile: 'dist/computer-use-safety-test.js' })
await build({ ...testCommon, entryPoints: ['./test/vision-budget.ts'], outfile: 'dist/vision-budget-test.js' })
await build({ ...testCommon, entryPoints: ['./test/measure-computer-use-ollama.ts'], outfile: 'dist/measure-computer-use-ollama.js' })
await build({ ...browser, entryPoints: ['./src/ui/main.ts'], outfile: 'dist/ui.js' })
