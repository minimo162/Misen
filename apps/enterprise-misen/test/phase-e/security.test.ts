import { strict as assert } from 'node:assert'
import { link, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  createEnterpriseCapabilityTools,
  ENTERPRISE_CAPABILITY_TOOL_NAMES,
  ENTERPRISE_FORBIDDEN_TOOL_NAMES,
  registerEnterpriseCapabilities,
} from '../../src/capabilities/index.js'
import { createPhaseAContext, PHASE_A_FORBIDDEN_SERVICES } from '../../src/runtime/phase-a.js'
import { WorkspaceBoundary } from '../../src/workspace/boundary.js'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SOURCE_ROOT = join(APP_ROOT, 'src')
const NODE_MODULES_ROOT = join(APP_ROOT, 'node_modules')

// Keep the security gate's expected surface independent from the production
// constants.  If a future edit changes both the registration and its exported
// list, this test must still detect the model-facing expansion.
const EXPECTED_CAPABILITY_NAMES = [
  'workspace_list_files',
  'workspace_read_text',
  'spreadsheet_read',
  'spreadsheet_create_output',
  'spreadsheet_update',
] as const
const EXPECTED_FORBIDDEN_TOOL_NAMES = [
  'bash',
  'run_code',
  'jobs',
  'skills',
  'shell',
  'powershell',
  'python',
  'grep',
  'glob',
  'plugin_discovery',
] as const

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`)
  }
  return value as JsonRecord
}

async function readJson(path: string): Promise<JsonRecord> {
  return asRecord(JSON.parse(await readFile(path, 'utf8')) as unknown, path)
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path)
    }
  }
  await visit(root)
  return files.sort()
}

/**
 * Remove comments and literals before looking for executable APIs.  Import
 * specifiers are checked against the original source separately, so masking
 * literals does not hide a forbidden module import.
 */
function maskCommentsAndLiterals(source: string): string {
  const withoutLiterals = source.replace(
    /'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*"|`(?:\\.|[^`\\])*`/g,
    literal => literal.replace(/[^\r\n]/g, ' '),
  )
  return withoutLiterals
    .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\r\n]/g, ' '))
    .replace(/\/\/[^\r\n]*/g, line => line.replace(/[^\r\n]/g, ' '))
}

async function allSourceText(): Promise<{ original: string; code: string }> {
  const contents = await Promise.all((await sourceFiles(SOURCE_ROOT)).map(path => readFile(path, 'utf8')))
  const original = contents.join('\n')
  return { original, code: maskCommentsAndLiterals(original) }
}

function findTool(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  return tool
}

test('Phase E model-facing surface is exactly the general File + Spreadsheet roster', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'misen-phase-e-roster-'))
  try {
    const boundary = new WorkspaceBoundary(root)
    const tools = createEnterpriseCapabilityTools(boundary)
    const expected = [...EXPECTED_CAPABILITY_NAMES]
    assert.deepEqual([...ENTERPRISE_CAPABILITY_TOOL_NAMES], expected, 'exported capability roster drifted')
    assert.deepEqual([...ENTERPRISE_FORBIDDEN_TOOL_NAMES], [...EXPECTED_FORBIDDEN_TOOL_NAMES], 'exported forbidden roster drifted')
    const names: string[] = tools.map(tool => tool.name)
    assert.deepEqual(names, expected)
    assert.equal(new Set(names).size, names.length, 'tool names must be unique')
    for (const forbidden of EXPECTED_FORBIDDEN_TOOL_NAMES) {
      assert.equal(new Set<string>(names).has(forbidden), false, `${forbidden} must not be model-facing`)
    }
    // Keep a direct assertion for the normal production registration path,
    // rather than relying only on the factory result.
    const ctx = await createPhaseAContext({ persona: 'Phase E security acceptance.' })
    let dispose: (() => void) | undefined
    try {
      dispose = registerEnterpriseCapabilities(ctx, boundary)
      assert.deepEqual(ctx.tools.schemas().map(schema => schema.name), expected)
      for (const service of PHASE_A_FORBIDDEN_SERVICES) {
        assert.equal(ctx.get(service), undefined, `${service} must not be mounted`)
      }
      for (const service of ['telemetry', 'backgroundJobs', 'pluginDiscovery', 'shell', 'codeRuntime']) {
        assert.equal(ctx.get(service), undefined, `${service} must not be mounted`)
      }
    } finally {
      dispose?.()
      await ctx.fiber.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Phase E production source stays in-process and does not expose executor, network, or discovery seams', async () => {
  const { original, code } = await allSourceText()

  // These checks intentionally target import specifiers in the original
  // source.  No child-process, network, worker, or module-loader API may be
  // introduced into the normal Misen runtime path.
  for (const moduleName of [
    'child_process',
    'node:child_process',
    'node:net',
    'node:http',
    'node:https',
    'node:tls',
    'node:dgram',
    'node:worker_threads',
  ]) {
    assert.doesNotMatch(original, new RegExp(`(?:from\\s+|import\\s*\\(\\s*)['"]${moduleName}['"]`, 'u'), `forbidden import ${moduleName}`)
  }

  // Executable API calls are searched after comments/literals are masked, so
  // explanatory documentation cannot produce a false positive.
  assert.doesNotMatch(code, /\b(?:spawn|spawnSync|exec|execFile|execSync|fork)\s*\(/u)
  assert.doesNotMatch(code, /\bprocess\s*\./u)
  assert.doesNotMatch(code, /\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(/u)
  assert.doesNotMatch(code, /\b(?:http|https|net|tls|dgram)\s*\./u)
  assert.doesNotMatch(code, /\b(?:npm|pnpm|yarn)\s+(?:install|ci|run\s+build)\b/iu)
  assert.doesNotMatch(code, /\b(?:download|install|build)\s*\(/iu)
  assert.doesNotMatch(code, /\b(?:dynamicImport|discoverPlugins?|pluginDiscovery|pluginInventory)\b/iu)
  assert.doesNotMatch(code, /\btelemetry\b/iu)

  // `ctx.plugin(...)` is the explicit, statically-owned DSH composition seam;
  // dynamic import/require/discovery is deliberately absent.
  assert.doesNotMatch(code, /\b(?:import|require)\s*\(/u)
  const compiledFiles = await filesWithExtensions(join(APP_ROOT, 'dist', 'src'), new Set(['.js']))
  const compiledSource = (await Promise.all(compiledFiles.map(path => readFile(path, 'utf8')))).join('\n')
  for (const staleLiteral of ['runMonthlyReport', 'process_three_companies', 'create_monthly_finance_report']) {
    assert.equal(compiledSource.includes(staleLiteral), false, `compiled output retains stale ${staleLiteral}`)
  }
  console.log('PHASE_E_STATIC_RUNTIME_BOUNDARY PASS (live PID/network observation is external acceptance evidence)')
})

test('Phase E lockfile and installed dependency graph are fixed, registry-backed, and non-native', async () => {
  const packageJson = await readJson(join(APP_ROOT, 'package.json'))
  const lockJson = await readJson(join(APP_ROOT, 'package-lock.json'))
  const sbomJson = await readJson(join(APP_ROOT, 'evidence', 'sbom.cdx.json'))
  const dependencies = asRecord(packageJson.dependencies, 'package.json dependencies')
  const lockPackages = asRecord(lockJson.packages, 'package-lock packages')
  const lockRoot = asRecord(lockPackages[''], 'package-lock root')

  assert.equal(lockRoot.name, packageJson.name)
  assert.equal(lockRoot.version, packageJson.version)
  assert.deepEqual(lockRoot.dependencies, dependencies)

  const directNames = Object.keys(dependencies).sort()
  assert.ok(directNames.length > 0)
  for (const name of directNames) {
    const spec = dependencies[name]
    assert.equal(typeof spec, 'string', `${name} must use a string version`)
    assert.doesNotMatch(String(spec), /^(?:[~^*]|[<>=]|git\+|git:|file:|https?:)/iu, `${name} must be exact and registry-backed`)
    const lockEntry = asRecord(lockPackages[`node_modules/${name}`], `lock entry ${name}`)
    assert.equal(lockEntry.version, spec, `${name} lock version must equal package.json`)
    assert.match(String(lockEntry.resolved), /^https:\/\/registry\.npmjs\.org\//u, `${name} must resolve from npm registry`)
    assert.match(String(lockEntry.integrity), /^sha512-/u, `${name} must have integrity`)
  }

  // Every DSH package in the resolved graph is pinned to the Decision 427
  // alpha.2 line; no transitive latest/range can silently enter the runtime.
  for (const [path, raw] of Object.entries(lockPackages)) {
    if (path === '' || !path.startsWith('node_modules/@deepseek-ai/dsh-')) continue
    const entry = asRecord(raw, path)
    assert.equal(entry.version, '0.1.2-alpha.2', `${path} must stay on DSH alpha.2`)
  }
  const xlsxEntry = asRecord(lockPackages['node_modules/@office-kit/xlsx'], 'office-kit/xlsx lock entry')
  assert.equal(xlsxEntry.version, dependencies['@office-kit/xlsx'])

  const manifests = await installedPackageManifests(NODE_MODULES_ROOT)
  assert.ok(manifests.length > 0, 'installed dependency manifests must be inspectable')
  const hookNames = ['preinstall', 'install', 'postinstall'] as const
  const observedInstallHooks: Array<{ name: string; version: string; hook: string; command: string }> = []
  for (const { path, manifest } of manifests) {
    const scripts = manifest.scripts === undefined ? {} : asRecord(manifest.scripts, `${path} scripts`)
    for (const hook of hookNames) {
      const command = scripts[hook]
      if (command === undefined) continue
      assert.equal(typeof command, 'string', `${path} ${hook} must be a string`)
      observedInstallHooks.push({
        name: String(manifest.name),
        version: String(manifest.version),
        hook,
        command: String(command),
      })
    }
    assert.equal(manifest.gypfile, undefined, `${path} must not declare a native gyp build`)
    assert.equal(manifest.binary, undefined, `${path} must not declare a native binary`)
  }
  // pi-ai's fixed provider graph declares these exact hooks. Production/runtime
  // never runs npm; clean verification installs use `npm ci --ignore-scripts`,
  // and any additional or changed hook fails here.
  assert.deepEqual(observedInstallHooks, [
    {
      name: '@google/genai',
      version: '1.52.0',
      hook: 'preinstall',
      command: "echo 'preinstall: no-op'",
    },
    {
      name: 'protobufjs',
      version: '7.6.6',
      hook: 'postinstall',
      command: 'node scripts/postinstall',
    },
  ])

  const nativeFiles = await filesWithExtensions(NODE_MODULES_ROOT, new Set(['.node', '.dll', '.exe']))
  assert.deepEqual(nativeFiles, [], 'installed graph must not contain native addons or binaries')

  const binDirectory = join(NODE_MODULES_ROOT, '.bin')
  let launchers: string[] = []
  try {
    launchers = (await readdir(binDirectory)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // `.bin` JS/cmd/ps1 launchers are intentionally not treated as production
  // native binaries; retain their names as auditable evidence in test output.
  console.log(`PHASE_E_NODE_MODULE_BIN_LAUNCHERS ${JSON.stringify(launchers)}`)
  console.log(`PHASE_E_INSTALL_HOOKS ${JSON.stringify(observedInstallHooks)}`)
  console.log(`PHASE_E_DEPENDENCY_GRAPH ${JSON.stringify({ packageCount: manifests.length, nativeFiles, launchers })}`)

  const sbomComponents = sbomJson.components
  assert.ok(Array.isArray(sbomComponents), 'SBOM components must be an array')
  const actualProduction = sbomComponents.map((raw, index) => {
    const component = asRecord(raw, `SBOM component ${index}`)
    return `${String(component.name)}@${String(component.version)}`
  }).sort()
  const expectedProduction = Object.entries(lockPackages)
    .filter(([path, raw]) => path !== '' && asRecord(raw, path).dev !== true)
    .map(([path, raw]) => {
      const entry = asRecord(raw, path)
      const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
      return `${name}@${String(entry.version)}`
    })
  const uniqueExpectedProduction = [...new Set(expectedProduction)].sort()
  assert.deepEqual(actualProduction, uniqueExpectedProduction, 'SBOM must exactly cover every unique non-dev lock package version')
  assert.equal(actualProduction.includes('@deepseek-ai/cordis@4.0.2'), true)
  assert.equal(actualProduction.includes('@deepseek-ai/dsh-attachment@0.1.2-alpha.2'), true, 'standard pi-ai production peer must enter the SBOM')
})

interface InstalledManifest {
  readonly path: string
  readonly manifest: JsonRecord
}

async function installedPackageManifests(root: string): Promise<InstalledManifest[]> {
  const result: InstalledManifest[] = []
  const exists = async (path: string): Promise<boolean> => {
    try {
      await readdir(path)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOTDIR') return true
      if (code === 'ENOENT') return false
      throw error
    }
  }

  const visitContainer = async (directory: string): Promise<void> => {
    if (!(await exists(directory))) return
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory() || entry.name === '.bin') continue
      const candidate = join(directory, entry.name)
      const packageJson = join(candidate, 'package.json')
      try {
        const manifest = await readJson(packageJson)
        result.push({ path: packageJson, manifest })
        await visitContainer(join(candidate, 'node_modules'))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
        // Scoped packages are represented by a scope directory containing
        // package directories, not by a package.json at the scope level.
        await visitContainer(candidate)
      }
    }
  }
  await visitContainer(root)
  return result.sort((left, right) => left.path.localeCompare(right.path))
}

async function filesWithExtensions(root: string, extensions: ReadonlySet<string>): Promise<string[]> {
  const result: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === '.bin') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        const dot = entry.name.lastIndexOf('.')
        if (dot >= 0 && extensions.has(entry.name.slice(dot).toLocaleLowerCase())) result.push(path)
      }
    }
  }
  await visit(root)
  return result.sort()
}

test('Phase E workspace boundary rejects host paths and confines writes to output', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'misen-phase-e-boundary-'))
  try {
    await mkdir(join(root, 'inputs'), { recursive: true })
    await writeFile(join(root, 'inputs', 'source.txt'), 'source\n', 'utf8')
    const boundary = new WorkspaceBoundary(root)

    await assert.rejects(() => boundary.resolveFile(join(root, 'inputs', 'source.txt')), /absolute|relative/iu)
    await assert.rejects(() => boundary.resolveFile('../outside.txt'), /workspace|relative|escape/iu)

    const hardlinkSource = join(root, '..', `misen-phase-e-hardlink-${process.pid}-${Date.now()}.txt`)
    await writeFile(hardlinkSource, 'outside\n', 'utf8')
    try {
      await link(hardlinkSource, join(root, 'inputs', 'hardlinked.txt'))
      await assert.rejects(() => boundary.resolveFile('inputs/hardlinked.txt'), /hard-linked/iu)
    } finally {
      await rm(hardlinkSource, { force: true })
    }
    await assert.rejects(() => boundary.resolveOutputFile('inputs/not-output.xlsx'), /output|workspace/iu)
    await boundary.ensureOutputDirectory()
    const output = await boundary.resolveOutputFile('output/report.xlsx')
    assert.equal(output, join(root, 'output', 'report.xlsx'))

    const tools = createEnterpriseCapabilityTools(boundary)
    const list = findTool(tools, 'workspace_list_files')
    assert.equal(list.name, 'workspace_list_files')
    console.log('PHASE_E_WORKSPACE_BOUNDARY PASS (relative reads; output-only xlsx writes)')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
