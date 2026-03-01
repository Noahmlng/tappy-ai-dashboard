import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAutoRefreshController } from '../../src/composables/use-auto-refresh'

function createEventTarget() {
  const listeners = new Map()

  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler)
    },
    emit(type) {
      for (const handler of listeners.get(type) || []) {
        handler()
      }
    },
  }
}

function createRuntime() {
  const windowEvents = createEventTarget()
  const documentEvents = createEventTarget()

  const windowRef = {
    ...windowEvents,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  }
  const documentRef = {
    ...documentEvents,
    visibilityState: 'visible',
  }

  return {
    windowRef,
    documentRef,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('use-auto-refresh controller', () => {
  it('runs on start and then on interval, and stops cleanly', async () => {
    vi.useFakeTimers()
    const runtime = createRuntime()
    const refresh = vi.fn(async () => {})
    const controller = createAutoRefreshController(refresh, {
      intervalMs: 30_000,
      runtime: {
        window: runtime.windowRef,
        document: runtime.documentRef,
      },
    })

    controller.start()
    expect(refresh).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(refresh).toHaveBeenCalledTimes(2)

    controller.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('refreshes on visibility resume and online event', async () => {
    vi.useFakeTimers()
    const runtime = createRuntime()
    const refresh = vi.fn(async () => {})
    const controller = createAutoRefreshController(refresh, {
      runOnStart: false,
      runtime: {
        window: runtime.windowRef,
        document: runtime.documentRef,
      },
    })

    controller.start()
    runtime.documentRef.visibilityState = 'hidden'
    runtime.documentRef.emit('visibilitychange')
    expect(refresh).toHaveBeenCalledTimes(0)

    runtime.documentRef.visibilityState = 'visible'
    runtime.documentRef.emit('visibilitychange')
    expect(refresh).toHaveBeenCalledTimes(1)
    await Promise.resolve()

    runtime.windowRef.emit('online')
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(2)

    controller.stop()
  })

  it('skips when busy and avoids concurrent refresh execution', async () => {
    vi.useFakeTimers()
    const runtime = createRuntime()
    let busy = true
    let resolveFirst = () => {}
    const refresh = vi.fn(() => new Promise((resolve) => {
      resolveFirst = resolve
    }))
    const controller = createAutoRefreshController(refresh, {
      intervalMs: 30_000,
      runOnStart: false,
      isBusy: () => busy,
      runtime: {
        window: runtime.windowRef,
        document: runtime.documentRef,
      },
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(refresh).toHaveBeenCalledTimes(0)

    busy = false
    const first = controller.triggerRefresh()
    const second = controller.triggerRefresh()
    expect(refresh).toHaveBeenCalledTimes(1)

    resolveFirst()
    await first
    await second

    controller.stop()
  })
})
