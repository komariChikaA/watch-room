import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import selfsigned from 'selfsigned'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const certDir = resolve(root, 'certs')
const certFile = resolve(certDir, 'cert.pem')
const keyFile = resolve(certDir, 'key.pem')
const port = Number(process.env.PORT || 8787)

function isShareable(address) {
  if (address.startsWith('169.254.')) return false
  if (address.startsWith('198.18.') || address.startsWith('198.19.')) return false
  return true
}

function lanAddresses() {
  const ips = ['127.0.0.1']
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal) continue
      const family = entry.family === 'IPv4' || entry.family === 4
      if (!family || !isShareable(entry.address)) continue
      ips.push(entry.address)
    }
  }
  return [...new Set(ips)]
}

function writeCertificate(ips) {
  mkdirSync(certDir, { recursive: true })
  if (existsSync(certFile) && existsSync(keyFile)) return
  const pems = selfsigned.generate([{ name: 'commonName', value: 'watch-room' }], {
    algorithm: 'sha256',
    days: 825,
    keySize: 2048,
    extensions: [{
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        ...ips.map((ip) => ({ type: 7, ip })),
      ],
    }],
  })
  writeFileSync(certFile, pems.cert)
  writeFileSync(keyFile, pems.private)
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('exit', (code) => {
      if (code === 0) resolveRun()
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
    })
  })
}

const ips = lanAddresses()
writeCertificate(ips)

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
await run(npm, ['run', 'build', '--prefix', 'web'])

const child = spawn(process.execPath, ['server/src/index.js'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(port),
    STATIC_DIR: resolve(root, 'web/dist'),
    TLS_CERT: certFile,
    TLS_KEY: keyFile,
  },
})

console.log('内网地址：')
for (const ip of ips) {
  if (ip === '127.0.0.1') continue
  console.log(`  https://${ip}:${port}`)
}
console.log('浏览器会提示证书不受信任，点继续访问。然后把房间链接发给别人。')

child.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
