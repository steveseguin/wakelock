// Run from the repository root: node --test wakelock_web/test/no_sleep_native.test.cjs
// Browser API doubles exercise the packaged JavaScript, without real wake locks.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const source = fs.readFileSync(
  process.env.NO_SLEEP_SOURCE || path.join(__dirname, '../assets/no_sleep.js'),
  'utf8'
)

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve))
}

function sentinel() {
  const listeners = []
  return {
    released: false,
    releases: 0,
    addEventListener(type, listener) {
      assert.equal(type, 'release')
      listeners.push(listener)
    },
    release() {
      this.released = true
      this.releases++
      // Keep event delivery explicit to exercise defensive ownership checks.
      return Promise.resolve()
    },
    emitRelease() {
      this.released = true
      listeners.forEach(listener => listener())
    },
  }
}

function fixture({ native = true } = {}) {
  const requests = []
  const errors = []
  const listeners = new Map()
  const video = {
    paused: true,
    setAttribute() {},
    appendChild() {},
    addEventListener() {},
    play() { this.paused = false; return Promise.resolve() },
    pause() { this.paused = true },
  }
  const document = {
    visibilityState: 'visible',
    addEventListener(type, listener) { listeners.set(type, listener) },
    createElement(type) { return type === 'video' ? video : {} },
  }
  const navigator = { userAgent: 'test-browser' }
  if (native) {
    navigator.wakeLock = {
      request(type) {
        assert.equal(type, 'screen')
        const request = deferred()
        requests.push(request)
        return request.promise
      },
    }
  }
  const context = vm.createContext({
    navigator, document, window: {}, setTimeout,
    console: { error: error => errors.push(error), warn() {} },
  })
  vm.runInContext(source, context, { filename: 'no_sleep.js' })
  return {
    api: context.Wakelock, requests, errors, video,
    event(type, state = 'visible') {
      document.visibilityState = state
      listeners.get(type)()
    },
  }
}

test('ordinary enable and disable release the acquired lock', async () => {
  const f = fixture()
  assert.equal(await f.api.enabled(), false)
  await f.api.toggle(true)
  const lock = sentinel()
  f.requests[0].resolve(lock)
  await flush()
  assert.equal(await f.api.enabled(), true)
  await f.api.toggle(false)
  assert.equal(lock.releases, 1)
  assert.equal(await f.api.enabled(), false)
})

test('disable releases a native request that resolves late', async () => {
  const f = fixture()
  await f.api.toggle(true)
  await f.api.toggle(false)
  const lock = sentinel()
  f.requests[0].resolve(lock)
  await flush()
  assert.equal(lock.releases, 1)
  assert.equal(await f.api.enabled(), false)
})

test('repeated enable calls share an outstanding request and acquired lock', async () => {
  const f = fixture()
  await f.api.toggle(true)
  await f.api.toggle(true)
  assert.equal(f.requests.length, 1)
  const lock = sentinel()
  f.requests[0].resolve(lock)
  await flush()
  await f.api.toggle(true)
  f.event('fullscreenchange')
  assert.equal(f.requests.length, 1)
  await f.api.toggle(false)
  assert.equal(lock.releases, 1)
})

test('enable after pending disable keeps the latest requested state', async () => {
  const f = fixture()
  await f.api.toggle(true)
  await f.api.toggle(false)
  await f.api.toggle(true)
  assert.equal(f.requests.length, 1)
  const lock = sentinel()
  f.requests[0].resolve(lock)
  await flush()
  assert.equal(lock.releases, 0)
  assert.equal(await f.api.enabled(), true)
})

test('an old release event cannot clear a newly acquired lock', async () => {
  const f = fixture()
  await f.api.toggle(true)
  const oldLock = sentinel()
  f.requests[0].resolve(oldLock)
  await flush()
  await f.api.toggle(false)
  await f.api.toggle(true)
  const newLock = sentinel()
  f.requests[1].resolve(newLock)
  await flush()
  oldLock.emitRelease()
  assert.equal(await f.api.enabled(), true)
  await f.api.toggle(false)
  assert.equal(newLock.releases, 1)
})

test('returning visible reacquires a browser-released lock once', async () => {
  const f = fixture()
  await f.api.toggle(true)
  const lock = sentinel()
  f.requests[0].resolve(lock)
  await flush()
  f.event('visibilitychange', 'hidden')
  lock.emitRelease()
  assert.equal(await f.api.enabled(), false)
  assert.equal(f.requests.length, 1)
  f.event('visibilitychange')
  f.event('fullscreenchange')
  assert.equal(f.requests.length, 2)
  const replacement = sentinel()
  f.requests[1].resolve(replacement)
  await flush()
  assert.equal(await f.api.enabled(), true)
  await f.api.toggle(false)
  assert.equal(replacement.releases, 1)
})

test('explicit disable prevents visibility events reacquiring the lock', async () => {
  const f = fixture()
  await f.api.toggle(true)
  const lock = sentinel()
  f.requests[0].resolve(lock)
  await flush()
  lock.emitRelease()
  await f.api.toggle(false)
  f.event('visibilitychange')
  f.event('fullscreenchange')
  assert.equal(f.requests.length, 1)
  assert.equal(await f.api.enabled(), false)
})

test('visibility return handles a released sentinel before its release event', async () => {
  const f = fixture()
  await f.api.toggle(true)
  const oldLock = sentinel()
  f.requests[0].resolve(oldLock)
  await flush()
  f.event('visibilitychange', 'hidden')
  oldLock.released = true
  f.event('visibilitychange')
  assert.equal(f.requests.length, 2)
  const replacement = sentinel()
  f.requests[1].resolve(replacement)
  await flush()
  oldLock.emitRelease()
  assert.equal(await f.api.enabled(), true)
  await f.api.toggle(false)
  assert.equal(replacement.releases, 1)
})

test('a late release failure cannot clear a newer request in progress', async () => {
  const f = fixture()
  await f.api.toggle(true)
  await f.api.toggle(false)
  const oldLock = sentinel()
  const release = deferred()
  oldLock.release = () => release.promise
  f.requests[0].resolve(oldLock)
  await flush()
  await f.api.toggle(true)
  assert.equal(f.requests.length, 2)
  release.reject(new Error('release failed'))
  await flush()
  await f.api.toggle(true)
  assert.equal(f.requests.length, 2)
  const replacement = sentinel()
  f.requests[1].resolve(replacement)
  await flush()
  assert.equal(await f.api.enabled(), true)
})

test('a failed native request reports disabled and permits retry', async () => {
  const f = fixture()
  await f.api.toggle(true)
  f.requests[0].reject(new Error('not allowed'))
  await flush()
  assert.equal(await f.api.enabled(), false)
  assert.equal(f.errors.length, 1)
  await f.api.toggle(true)
  assert.equal(f.requests.length, 2)
  const lock = sentinel()
  f.requests[1].resolve(lock)
  await flush()
  assert.equal(await f.api.enabled(), true)
})

test('disabled state stays false when releasing a late lock fails', async () => {
  const f = fixture()
  await f.api.toggle(true)
  await f.api.toggle(false)
  const lock = sentinel()
  lock.release = () => Promise.reject(new Error('release failed'))
  f.requests[0].resolve(lock)
  await flush()
  assert.equal(await f.api.enabled(), false)
  assert.equal(f.errors.length, 1)
})

test('the video fallback still follows enable and disable', async () => {
  const f = fixture({ native: false })
  assert.equal(await f.api.enabled(), false)
  await f.api.toggle(true)
  assert.equal(await f.api.enabled(), true)
  await f.api.toggle(false)
  assert.equal(await f.api.enabled(), false)
  assert.equal(f.video.paused, true)
})
