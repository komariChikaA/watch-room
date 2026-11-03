import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { etagMatches, fileEtag, parseByteRange } from '../src/media-file.js'
import { start } from '../src/index.js'

describe('byte ranges', () => {
  it('reads the whole file when no range is requested', () => {
    assert.equal(parseByteRange(undefined, 100), null)
    assert.equal(parseByteRange('', 100), null)
  })

  it('keeps a closed range inside the file', () => {
    assert.deepEqual(parseByteRange('bytes=0-9', 100), { start: 0, end: 9 })
    assert.deepEqual(parseByteRange('bytes=40-', 100), { start: 40, end: 99 })
    assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 })
  })

  it('rejects a range that starts past the end', () => {
    assert.deepEqual(parseByteRange('bytes=100-', 100), { error: 416 })
    assert.deepEqual(parseByteRange('bytes=5-4', 100), { error: 416 })
  })

  it('matches the file etag', () => {
    const etag = fileEtag(16, 32)
    assert.equal(etagMatches(etag, etag), true)
    assert.equal(etagMatches('*', etag), true)
    assert.equal(etagMatches('W/"other"', etag), false)
  })
})

describe('media responses', () => {
  let app
  let dir

  after(async () => {
    if (app) await app.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('sends a complete file, then only the requested slice', async () => {
    dir = await mkdtemp(join(tmpdir(), 'watch-room-media-'))
    const bytes = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    await writeFile(join(dir, 'clip.mp4'), bytes)
    app = start(0, { staticDir: dir })
    await new Promise((resolve) => app.httpServer.once('listening', resolve))
    const port = app.httpServer.address().port
    const url = `http://127.0.0.1:${port}/clip.mp4`

    const full = await fetch(url)
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('content-type'), 'video/mp4')
    assert.equal(full.headers.get('accept-ranges'), 'bytes')
    assert.equal(Number(full.headers.get('content-length')), bytes.length)
    assert.equal(await full.text(), bytes.toString())

    const etag = full.headers.get('etag')
    const cached = await fetch(url, { headers: { 'if-none-match': etag } })
    assert.equal(cached.status, 304)
    assert.equal(await cached.text(), '')

    const slice = await fetch(url, { headers: { range: 'bytes=0-3' } })
    assert.equal(slice.status, 206)
    assert.equal(slice.headers.get('content-range'), `bytes 0-3/${bytes.length}`)
    assert.equal(Number(slice.headers.get('content-length')), 4)
    assert.equal(await slice.text(), 'abcd')

    const missing = await fetch(url.replace('clip.mp4', 'missing.mp4'))
    assert.equal(missing.status, 404)
  })
})
