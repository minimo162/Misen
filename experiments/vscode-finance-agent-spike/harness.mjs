import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const enterpriseRoot = join(repoRoot, 'apps', 'enterprise-misen')
const templateRoot = join(here, 'workspace-template')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const months = { july: '7月', august: '8月', '7月': '7月', '8月': '8月' }
const runFile = promisify(execFile)

function fail(message) {
  throw new Error(message)
}

function scenarioFor(fixtures, month) {
  const scenario = fixtures.find(candidate => candidate.month === month)
  if (!scenario) fail(`fixture scenario unavailable: ${month}`)
  return scenario
}

function inputPaths(scenario) {
  return [
    'master.xlsx',
    '月次管理レポート_template.xlsx',
    ...scenario.companies.map(company => `${scenario.month}/${company.company}.xlsx`),
  ]
}

async function hashFiles(workspace, paths) {
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, digest(await readFile(join(workspace, path)))])))
}

async function loadRuntime() {
  const fixtureModule = join(enterpriseRoot, 'dist', 'demo', 'enterprise-excel', 'fixtures.js')
  const validatorModule = join(enterpriseRoot, 'dist', 'src', 'acceptance', 'validator.js')
  try {
    await stat(fixtureModule)
    await stat(validatorModule)
  } catch {
    fail('Enterprise Misen dist is missing; run npm ci and npm run build in apps/enterprise-misen')
  }
  return {
    fixtures: await import(pathToFileURL(fixtureModule)),
    validator: await import(pathToFileURL(validatorModule)),
  }
}

async function prepare(month, runRoot) {
  try {
    await stat(runRoot)
    fail(`run target already exists: ${runRoot}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const { fixtures, validator } = await loadRuntime()
  const scenario = scenarioFor(fixtures.SYNTHETIC_MONTHS, month)
  const workspace = join(runRoot, 'workspace')
  await mkdir(workspace, { recursive: true })
  await cp(templateRoot, workspace, {
    recursive: true,
    filter: source => !source.split(/[\\/]/u).includes('node_modules'),
  })
  await fixtures.fixture(workspace)
  const excluded = fixtures.SYNTHETIC_MONTHS.filter(candidate => candidate.month !== month)
  for (const candidate of excluded) await rm(join(workspace, candidate.month), { recursive: true })
  const inputs = inputPaths(scenario)
  const npmCommand = process.platform === 'win32' ? process.execPath : 'npm'
  const npmArguments = process.platform === 'win32'
    ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'ci', '--ignore-scripts']
    : ['ci', '--ignore-scripts']
  await runFile(npmCommand, npmArguments, {
    cwd: workspace,
    windowsHide: true,
  })
  const before = await hashFiles(workspace, inputs)
  const outputBefore = Object.fromEntries(await validator.snapshotOutputScope(workspace))
  const manifest = {
    schemaVersion: 1,
    month,
    workspace: 'workspace',
    inputs,
    before,
    outputBefore,
    prompt: fixtures.PROMPTS[month],
    preparedAt: new Date().toISOString(),
  }
  await writeFile(join(runRoot, 'operator-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({
    status: 'PREPARED',
    month,
    workspace,
    manifest: join(runRoot, 'operator-manifest.json'),
    prompt: manifest.prompt,
    inputs: before,
  }, null, 2))
}

async function validate(month, runRoot) {
  const { fixtures, validator } = await loadRuntime()
  const scenario = scenarioFor(fixtures.SYNTHETIC_MONTHS, month)
  const workspace = join(runRoot, 'workspace')
  const manifest = JSON.parse(await readFile(join(runRoot, 'operator-manifest.json'), 'utf8'))
  if (manifest.month !== month || manifest.workspace !== 'workspace') fail('operator manifest does not match requested run')
  const before = new Map(Object.entries(manifest.before))
  const outputBefore = new Map(Object.entries(manifest.outputBefore))
  const after = await hashFiles(workspace, manifest.inputs)
  const result = await validator.validateReport(workspace, scenario, before, outputBefore)
  const outputPath = join(workspace, result.output)
  const evidence = {
    status: result.passed ? 'PASS' : 'FAIL',
    month,
    inputBeforeHashes: manifest.before,
    inputAfterHashes: after,
    inputUnchanged: JSON.stringify(manifest.before) === JSON.stringify(after),
    output: { path: result.output, exists: true, readable: true, bytes: (await stat(outputPath)).size },
    axes: result.axes,
    diagnostics: result.diagnostics,
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!result.passed) process.exitCode = 1
}

const [command, monthArgument, runArgument] = process.argv.slice(2)
const month = months[monthArgument]
if (!['prepare', 'validate'].includes(command) || !month || !runArgument) {
  fail('usage: node harness.mjs prepare|validate july|august <new-or-existing-run-directory>')
}
const runRoot = resolve(repoRoot, runArgument)
const relativeRun = relative(repoRoot, runRoot)
if (!relativeRun || relativeRun.startsWith('..')) fail('run directory must be inside the repository worktree')

if (command === 'prepare') await prepare(month, runRoot)
else await validate(month, runRoot)
