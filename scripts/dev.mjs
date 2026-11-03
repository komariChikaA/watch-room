import { spawn } from 'node:child_process'
import process from 'node:process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const children = []

function run(args, cwd) {
  const child = spawn(npm, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  })
  children.push(child)
  child.on('exit', (code, signal) => {
    if (signal) return
    for (const other of children) {
      if (other !== child && !other.killed) other.kill()
    }
    process.exit(code ?? 0)
  })
}

run(['run', 'dev'], 'server')
run(['run', 'dev'], 'web')

function stop() {
  for (const child of children) {
    if (!child.killed) child.kill()
  }
}

process.on('SIGINT', () => {
  stop()
  process.exit(0)
})
process.on('SIGTERM', () => {
  stop()
  process.exit(0)
})
