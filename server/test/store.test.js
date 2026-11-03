import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createStore } from '../src/store.js'

function makeStore(extra = {}) {
  let clock = 1_000_000
  const store = createStore({
    now: () => clock,
    maxMembers: 3,
    ...extra,
  })
  return {
    store,
    advance(ms) {
      clock += ms
    },
  }
}

describe('rooms', () => {
  it('creates a room and lets the host reclaim it with a token', () => {
    const { store } = makeStore()
    const created = store.create({ name: '阿宁', title: '周五夜', password: 'pine' })
    assert.equal(created.error, undefined)
    assert.equal(created.state.hasPassword, true)
    assert.equal(created.state.members.length, 0)
    assert.equal(JSON.stringify(created.state).includes('pine'), false)
    assert.equal(JSON.stringify(created.state).includes(created.hostToken), false)

    const host = store.join({
      roomId: created.state.id.toLowerCase(),
      name: '阿宁',
      hostToken: created.hostToken,
      socketId: 'host-1',
    })
    assert.equal(host.role, 'host')
    assert.equal(host.state.members[0].role, 'host')
    assert.equal(host.state.hostAway, false)
    assert.equal(host.state.messages.some((item) => item.text === '主持人回来了'), false)
  })

  it('rejects the wrong password and accepts the right one', () => {
    const { store } = makeStore()
    const created = store.create({ name: '阿宁', title: '周五夜', password: 'pine' })
    const denied = store.join({
      roomId: created.state.id,
      name: '小林',
      password: 'nope',
      socketId: 'viewer-1',
    })
    assert.equal(denied.error, '密码不正确')

    const joined = store.join({
      roomId: created.state.id,
      name: '小林',
      password: 'pine',
      socketId: 'viewer-1',
    })
    assert.equal(joined.role, 'viewer')
    assert.equal(joined.state.members.length, 1)
  })

  it('lets an open room be joined with an empty password', () => {
    const { store } = makeStore()
    const created = store.create({ name: '阿宁', password: '' })
    assert.equal(created.state.title, '未命名放映室')
    const joined = store.join({
      roomId: created.state.id,
      name: '小林',
      password: '',
      socketId: 'viewer-1',
    })
    assert.equal(joined.role, 'viewer')
  })

  it('keeps the room after the last person leaves, until it expires', () => {
    const { store, advance } = makeStore()
    const created = store.create({ name: '阿宁', password: 'pine' })
    store.join({
      roomId: created.state.id,
      name: '阿宁',
      hostToken: created.hostToken,
      socketId: 'host-1',
    })
    const left = store.leave('host-1')
    assert.equal(left.empty, true)

    const back = store.join({
      roomId: created.state.id,
      name: '阿宁',
      hostToken: created.hostToken,
      socketId: 'host-2',
    })
    assert.equal(back.role, 'host')
    assert.equal(back.state.messages.some((item) => item.text === '主持人回来了'), false)

    store.leave('host-2')
    advance(10 * 60 * 1000 + 1)
    store.sweep()
    const gone = store.join({
      roomId: created.state.id,
      name: '阿宁',
      hostToken: created.hostToken,
      socketId: 'host-3',
    })
    assert.equal(gone.error, '找不到这个放映室')
  })

  it('pauses the screening when the host leaves viewers behind', () => {
    const { store } = makeStore()
    const created = store.create({ name: '阿宁', password: '' })
    store.join({
      roomId: created.state.id,
      name: '阿宁',
      hostToken: created.hostToken,
      socketId: 'host-1',
    })
    store.join({ roomId: created.state.id, name: '小林', password: '', socketId: 'viewer-1' })
    store.setScreening({ socketId: 'host-1', active: true })
    const left = store.leave('host-1')
    assert.equal(left.state.screening, false)
    assert.equal(left.state.hostAway, true)
    assert.equal(left.state.messages.at(-1).text, '主持人暂时离开，放映已暂停')

    const returned = store.join({
      roomId: created.state.id,
      name: '阿宁',
      hostToken: created.hostToken,
      socketId: 'host-2',
    })
    assert.equal(returned.state.messages.at(-1).text, '主持人回来了')
    assert.equal(returned.state.hostAway, false)

    const viewer = store.setScreening({ socketId: 'viewer-1', active: true })
    assert.equal(viewer.error, '只有主持人可以放映')
  })

  it('limits chat speed and who can kick', () => {
    const { store, advance } = makeStore()
    const created = store.create({ name: '阿宁', password: '' })
    store.join({
      roomId: created.state.id,
      name: '阿宁',
      hostToken: created.hostToken,
      socketId: 'host-1',
    })
    store.join({ roomId: created.state.id, name: '小林', password: '', socketId: 'viewer-1' })

    const first = store.chat({ socketId: 'viewer-1', text: '  到哪了  ' })
    assert.equal(first.state.messages.at(-1).text, '到哪了')
    const rushed = store.chat({ socketId: 'viewer-1', text: '再来一条' })
    assert.equal(rushed.error, '发送太快了')
    advance(400)
    const second = store.chat({ socketId: 'viewer-1', text: '再来一条' })
    assert.equal(second.ok, true)

    const denied = store.beginKick({ socketId: 'viewer-1', targetId: 'host-1' })
    assert.equal(denied.error, '只有主持人可以移出观众')
    const kicked = store.beginKick({ socketId: 'host-1', targetId: 'viewer-1' })
    assert.equal(kicked.ok, true)
    const after = store.leave('viewer-1', { silent: true })
    assert.equal(after.state.members.some((member) => member.id === 'viewer-1'), false)
    assert.equal(after.state.messages.at(-1).text, '小林 被移出放映室')
  })

  it('stops taking viewers when the room is full', () => {
    const { store } = makeStore()
    const created = store.create({ name: '阿宁', password: '' })
    store.join({
      roomId: created.state.id,
      name: '阿宁',
      hostToken: created.hostToken,
      socketId: 'host-1',
    })
    store.join({ roomId: created.state.id, name: '甲', password: '', socketId: 'v1' })
    store.join({ roomId: created.state.id, name: '乙', password: '', socketId: 'v2' })
    const full = store.join({ roomId: created.state.id, name: '丙', password: '', socketId: 'v3' })
    assert.equal(full.error, '这个放映室已满')
  })

  it('syncs playback from the host and pauses it when the host leaves', () => {
    const { store, advance } = makeStore()
    const created = store.create({ name: '阿宁', password: '' })
    store.join({
      roomId: created.state.id,
      name: '阿宁',
      hostToken: created.hostToken,
      socketId: 'host-1',
    })
    store.join({ roomId: created.state.id, name: '小林', password: '', socketId: 'viewer-1' })

    const denied = store.setPlayback({ socketId: 'viewer-1', url: 'https://example.com/a.mp4' })
    assert.equal(denied.error, '只有主持人可以控制播放')
    const bad = store.setPlayback({ socketId: 'host-1', url: 'javascript:alert(1)' })
    assert.equal(bad.error, '只支持 http 或 https 视频')

    const loaded = store.setPlayback({ socketId: 'host-1', url: '/sample.mp4' })
    assert.equal(loaded.state.playback.url, '/sample.mp4')
    assert.equal(loaded.state.playback.playing, false)
    assert.equal(loaded.state.messages.at(-1).text, '开始同步播放')

    store.setPlayback({ socketId: 'host-1', playing: true, position: 1.25 })
    advance(2000)
    const left = store.leave('host-1')
    assert.equal(left.state.playback.playing, false)
    assert.equal(left.state.playback.position, 3.25)
    assert.equal(left.state.messages.at(-1).text, '主持人暂时离开，放映已暂停')
  })

  it('lets people in the room join and mute voice', () => {
    const { store } = makeStore()
    const created = store.create({ name: '阿宁', password: '' })
    store.join({
      roomId: created.state.id,
      name: '阿宁',
      hostToken: created.hostToken,
      socketId: 'host-1',
    })
    store.join({ roomId: created.state.id, name: '小林', password: '', socketId: 'viewer-1' })

    const outsider = store.joinVoice('missing')
    assert.equal(outsider.error, '你还不在放映室里')

    const hostVoice = store.joinVoice('host-1')
    assert.deepEqual(hostVoice.peers, [])
    assert.equal(hostVoice.state.members.find((member) => member.id === 'host-1').voice, true)

    const viewerVoice = store.joinVoice('viewer-1')
    assert.deepEqual(viewerVoice.peers, ['host-1'])
    const muted = store.setVoiceMuted({ socketId: 'viewer-1', muted: true })
    assert.equal(muted.state.members.find((member) => member.id === 'viewer-1').muted, true)

    const left = store.leaveVoice('viewer-1')
    assert.equal(left.state.members.find((member) => member.id === 'viewer-1').voice, false)
    const denied = store.setVoiceMuted({ socketId: 'viewer-1', muted: true })
    assert.equal(denied.error, '你还没加入语音')

    store.joinVoice('host-1')
    const gone = store.leave('host-1')
    assert.equal(gone.wasInVoice, true)
  })

  it('rejects a stale host token instead of treating it as a viewer', () => {
    const { store } = makeStore()
    const created = store.create({ name: '阿宁', password: '' })
    const stale = store.join({
      roomId: created.state.id,
      name: '阿宁',
      hostToken: 'not-the-token',
      socketId: 'host-1',
    })
    assert.equal(stale.error, '主持人身份已失效，请用密码重新加入')
  })
})
