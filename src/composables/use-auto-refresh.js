import { onBeforeUnmount, onMounted } from 'vue'

function noop() {}

function resolveRuntime(runtime = {}) {
  if (runtime.window || runtime.document) {
    return {
      windowRef: runtime.window || null,
      documentRef: runtime.document || null,
    }
  }
  return {
    windowRef: typeof window !== 'undefined' ? window : null,
    documentRef: typeof document !== 'undefined' ? document : null,
  }
}

export function createAutoRefreshController(refreshFn, options = {}) {
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 30_000
  const isBusy = typeof options.isBusy === 'function' ? options.isBusy : () => false
  const onError = typeof options.onError === 'function' ? options.onError : noop
  const runOnStart = options.runOnStart !== false
  const { windowRef, documentRef } = resolveRuntime(options.runtime || {})

  let started = false
  let inFlight = false
  let intervalId = null

  async function triggerRefresh() {
    if (inFlight || isBusy()) return false
    inFlight = true
    try {
      await Promise.resolve(refreshFn())
      return true
    } catch (error) {
      onError(error)
      return false
    } finally {
      inFlight = false
    }
  }

  function handleVisibilityChange() {
    if (!documentRef) return
    const state = String(documentRef.visibilityState || 'visible').toLowerCase()
    if (state !== 'visible') return
    void triggerRefresh()
  }

  function handleOnline() {
    void triggerRefresh()
  }

  function start() {
    if (started) return
    started = true

    if (runOnStart) {
      void triggerRefresh()
    }

    if (windowRef && typeof windowRef.setInterval === 'function') {
      intervalId = windowRef.setInterval(() => {
        void triggerRefresh()
      }, intervalMs)
    }
    if (documentRef && typeof documentRef.addEventListener === 'function') {
      documentRef.addEventListener('visibilitychange', handleVisibilityChange)
    }
    if (windowRef && typeof windowRef.addEventListener === 'function') {
      windowRef.addEventListener('online', handleOnline)
    }
  }

  function stop() {
    if (!started) return
    started = false
    if (windowRef && typeof windowRef.clearInterval === 'function' && intervalId !== null) {
      windowRef.clearInterval(intervalId)
      intervalId = null
    }
    if (documentRef && typeof documentRef.removeEventListener === 'function') {
      documentRef.removeEventListener('visibilitychange', handleVisibilityChange)
    }
    if (windowRef && typeof windowRef.removeEventListener === 'function') {
      windowRef.removeEventListener('online', handleOnline)
    }
  }

  return {
    start,
    stop,
    triggerRefresh,
  }
}

export function useAutoRefresh(refreshFn, options = {}) {
  const controller = createAutoRefreshController(refreshFn, options)

  onMounted(() => {
    controller.start()
  })

  onBeforeUnmount(() => {
    controller.stop()
  })

  return {
    triggerRefresh: controller.triggerRefresh,
  }
}
