import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const workspaceRoot = resolve(projectRoot, '..')
const aggregatedWorkspaceRoot = resolve(workspaceRoot, 'CLIProxy')
const defaultCpaRoot = existsSync(resolve(workspaceRoot, 'CLIProxyApi'))
  ? resolve(workspaceRoot, 'CLIProxyApi')
  : resolve(aggregatedWorkspaceRoot, 'CLIProxyApi')
const cpaRoot = process.env.CLIPROXYAPI_DIR
  ? resolve(process.env.CLIPROXYAPI_DIR)
  : defaultCpaRoot
const resourcesRoot = resolve(projectRoot, 'src-tauri/resources/sidecar')

if (!existsSync(cpaRoot)) {
  console.error(`CLIProxyApi workspace not found at ${cpaRoot}`)
  process.exit(1)
}

const rustHost = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  .split('\n')
  .find((line) => line.startsWith('host: '))
  ?.replace('host: ', '')
  .trim()

if (!rustHost) {
  console.error('Unable to determine Rust host target')
  process.exit(1)
}

const targetMap = new Map([
  ['aarch64-apple-darwin', { folder: 'darwin-aarch64', filename: 'cliproxyapi' }],
  ['x86_64-apple-darwin', { folder: 'darwin-x86_64', filename: 'cliproxyapi' }],
  ['x86_64-pc-windows-msvc', { folder: 'windows-x86_64', filename: 'cliproxyapi.exe' }],
  ['aarch64-pc-windows-msvc', { folder: 'windows-aarch64', filename: 'cliproxyapi.exe' }],
  ['x86_64-unknown-linux-gnu', { folder: 'linux-x86_64', filename: 'cliproxyapi' }],
  ['aarch64-unknown-linux-gnu', { folder: 'linux-aarch64', filename: 'cliproxyapi' }]
])

const target = targetMap.get(rustHost)
if (!target) {
  console.error(`Unsupported host target: ${rustHost}`)
  process.exit(1)
}

const outputDir = join(resourcesRoot, target.folder)
const outputPath = join(outputDir, target.filename)

mkdirSync(outputDir, { recursive: true })
rmSync(outputPath, { force: true })

console.log(`Building CLIProxyApi sidecar for ${rustHost}`)
execFileSync(
  'go',
  ['build', '-o', outputPath, './cmd/server'],
  {
    cwd: cpaRoot,
    stdio: 'inherit',
    env: process.env
  }
)

console.log(`Built sidecar: ${outputPath}`)
