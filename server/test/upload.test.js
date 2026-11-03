import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { start } from '../src/index.js'

describe('video upload', () => {
  let app
  let dir

  after(async () => {
    if (app) await app.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('keeps a complete file for the room and serves it in pieces', async () => {
    dir = await mkdtemp(join(tmpdir(), 'watch-room-upload-'))
    app = start(0, { uploadDir: dir, maxUploadBytes: 32 })
    await new Promise((resolve) => app.httpServer.once('listening', resolve))
    const port = app.httpServer.address().port
    const base = `http://127.0.0.1:${port}`

    const created = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '阿宁', title: '夜场' }),
    }).then((res) => res.json())

    const denied = await fetch(`${base}/api/rooms/${created.roomId}/video`, {
      method: 'POST',
      headers: {
        'x-host-token': 'nope',
        'x-file-name': 'clip.mp4',
        'content-type': 'video/mp4',
        'content-length': '4',
      },
      body: Buffer.from('nope'),
    })
    assert.equal(denied.status, 403)

    const oversized = await fetch(`${base}/api/rooms/${created.roomId}/video`, {
      method: 'POST',
      headers: {
        'x-host-token': created.hostToken,
        'x-file-name': 'clip.mp4',
        'content-type': 'video/mp4',
        'content-length': '40',
      },
      body: Buffer.alloc(40),
    })
    assert.equal(oversized.status, 400)
    assert.match((await oversized.json()).error, /太大/)

    const bytes = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    const uploaded = await fetch(`${base}/api/rooms/${created.roomId}/video`, {
      method: 'POST',
      headers: {
        'x-host-token': created.hostToken,
        'x-file-name': encodeURIComponent('夜场.mp4'),
        'content-type': 'video/mp4',
        'content-length': String(bytes.length),
      },
      body: bytes,
    })
    assert.equal(uploaded.status, 201)
    const { url } = await uploaded.json()
    assert.match(url, /^\/uploads\/[a-f0-9]{32}\.mp4$/)

    const full = await fetch(`${base}${url}`)
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('content-type'), 'video/mp4')
    assert.equal(Number(full.headers.get('content-length')), bytes.length)
    assert.equal(await full.text(), bytes.toString())

    const slice = await fetch(`${base}${url}`, { headers: { range: 'bytes=0-3' } })
    assert.equal(slice.status, 206)
    assert.equal(await slice.text(), 'abcd')

    const names = await readdir(dir)
    assert.deepEqual(names, [url.slice('/uploads/'.length)])
  })
})
