/** Serializes remote writes per store and retries the latest value after failures. */
export function createAtprotoWriteQueue(
  write: (key: string, value: string) => Promise<void>,
  options: { retryMs?: number; onError?: (error: unknown) => void } = {},
) {
  const pending = new Map<string, string>()
  const acknowledged = new Map<string, string>()
  const running = new Map<string, Promise<void>>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let stopped = false

  async function drain(key: string) {
    while (!stopped && pending.has(key)) {
      const value = pending.get(key)!
      try {
        await write(key, value)
        acknowledged.set(key, value)
        if (pending.get(key) === value) pending.delete(key)
      } catch (error) {
        options.onError?.(error)
        if (!stopped && !timers.has(key)) {
          timers.set(
            key,
            setTimeout(() => {
              timers.delete(key)
              void flush(key)
            }, options.retryMs ?? 5000),
          )
        }
        return
      }
    }
  }

  function flush(key: string): Promise<void> {
    if (stopped) return Promise.resolve()
    const active = running.get(key)
    if (active) return active
    const timer = timers.get(key)
    if (timer) clearTimeout(timer)
    timers.delete(key)
    const task = drain(key).finally(() => {
      running.delete(key)
    })
    running.set(key, task)
    return task
  }

  return {
    enqueue(key: string, value: string) {
      if (stopped) return
      if (!pending.has(key) && acknowledged.get(key) === value) return
      pending.set(key, value)
      return flush(key)
    },
    flush: () => Promise.all([...pending.keys()].map(flush)),
    stop() {
      stopped = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      pending.clear()
    },
  }
}
