import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const workspaceRoot = resolve(projectRoot, '..')
const aggregatedWorkspaceRoot = resolve(workspaceRoot, 'CLIProxy')
const defaultCpmRoot = existsSync(resolve(workspaceRoot, 'CLIProxyManagement'))
  ? resolve(workspaceRoot, 'CLIProxyManagement')
  : resolve(aggregatedWorkspaceRoot, 'CLIProxyManagement')
const cpmRoot = process.env.CLIPROXYMANAGEMENT_DIR
  ? resolve(process.env.CLIPROXYMANAGEMENT_DIR)
  : defaultCpmRoot
const cpmDist = resolve(cpmRoot, 'dist')
const targetDir = resolve(projectRoot, 'public/cpm')

if (!existsSync(cpmRoot)) {
  console.error(`CLIProxyManagement workspace not found at ${cpmRoot}`)
  process.exit(1)
}

const cpmNodeModules = resolve(cpmRoot, 'node_modules')
if (!existsSync(cpmNodeModules)) {
  // Prefer a reproducible install when a lockfile exists; otherwise fall back
  // to npm install, since npm ci requires a package-lock.json / npm-shrinkwrap.json.
  const hasLockfile =
    existsSync(resolve(cpmRoot, 'package-lock.json')) ||
    existsSync(resolve(cpmRoot, 'npm-shrinkwrap.json'))
  const installArgs = hasLockfile ? ['ci'] : ['install']
  console.log(`Installing CLIProxyManagement dependencies in ${cpmRoot} (npm ${installArgs[0]})`)
  execFileSync('npm', installArgs, {
    cwd: cpmRoot,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32'
  })
}

console.log(`Building CLIProxyManagement from ${cpmRoot}`)
execFileSync('npm', ['run', 'build'], {
  cwd: cpmRoot,
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32'
})

if (!existsSync(cpmDist)) {
  console.error(`CLIProxyManagement dist not found at ${cpmDist}`)
  process.exit(1)
}

if (process.platform === 'win32') {
  execFileSync('cmd', ['/d', '/c', 'if', 'exist', targetDir, 'rmdir', '/s', '/q', targetDir], {
    stdio: 'inherit'
  })
  mkdirSync(targetDir, { recursive: true })
  try {
    execFileSync('robocopy', [cpmDist, targetDir, '/E'], {
      stdio: 'inherit'
    })
  } catch (error) {
    const status = typeof error.status === 'number' ? error.status : 1
    if (status > 7) {
      throw error
    }
  }
} else {
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  cpSync(cpmDist, targetDir, { recursive: true })
}

console.log(`Prepared CPM assets at ${targetDir}`)
