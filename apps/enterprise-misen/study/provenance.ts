import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRODUCTION_BASELINE_SHA } from './schema.js'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const protectedPaths = [
  'apps/enterprise-misen/src',
  'apps/enterprise-misen/acceptance',
  'apps/enterprise-misen/demo',
  'apps/enterprise-misen/package-lock.json',
]
const observerPaths = [
  'apps/enterprise-misen/study',
  'apps/enterprise-misen/docs/reliability-study.md',
  'apps/enterprise-misen/test/study-observer.test.ts',
  'apps/enterprise-misen/package.json',
  'apps/enterprise-misen/tsconfig.json',
]

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: appRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function quietDiff(args: string[]): void {
  try { execFileSync('git', ['diff', '--quiet', ...args], { cwd: appRoot, stdio: 'ignore' }) }
  catch { throw new Error('repository provenance mismatch') }
}

export function verifyRepositoryProvenance(observerSha: string): void {
  if (git(['rev-parse', 'HEAD']) !== observerSha) throw new Error('observer SHA does not equal current HEAD')
  if (git(['rev-parse', `${PRODUCTION_BASELINE_SHA}^{commit}`]) !== PRODUCTION_BASELINE_SHA) throw new Error('production baseline commit is unavailable')
  quietDiff([PRODUCTION_BASELINE_SHA, 'HEAD', '--', ...protectedPaths])
  quietDiff(['HEAD', '--', ...protectedPaths, ...observerPaths])
  quietDiff(['--cached', 'HEAD', '--', ...protectedPaths, ...observerPaths])
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...protectedPaths, ...observerPaths])
  if (untracked) throw new Error('untracked observer or production files reject provenance')
}
