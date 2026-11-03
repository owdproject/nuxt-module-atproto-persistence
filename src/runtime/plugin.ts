import { createPersistedStatePlugin } from 'pinia-plugin-persistedstate-2'
import { defineNuxtPlugin } from 'nuxt/app'
import { nextTick, watch } from 'vue'
import { useAtprotoAgent, useAtprotoSession } from '#imports'
import { useDesktopApplication } from '@owdproject/nuxt/runtime/composables/useDesktopApplication'
import { get, set, del, keys } from 'idb-keyval'
import {
  parseAtprotoStoreKey,
  putAtprotoApplicationState,
  resolveDesktopId,
  toLocalStorageKey,
} from './utils/utilAtprotoApplicationStates'
import {
  ensureActorStatesLoaded,
  resolveRestoreActorDid,
  invalidateActorStates,
} from './utils/utilAtprotoPersistenceLoad'
import { createAtprotoWriteQueue } from './utils/utilAtprotoWriteQueue'

function mapStoreKey(key: string): string {
  if (key === 'desktop') return 'owd/desktop'
  if (key.startsWith('desktop/application/'))
    return key.replace(/^desktop\/application\//, 'owd/application/')
  if (key.startsWith('desktop/'))
    return key.replace(/^desktop\//, 'owd/desktop/')
  return key
}

/** Keep setup-store reactive objects alive while replacing their persisted contents. */
function replaceState(store: any, value: Record<string, any>) {
  store.$patch((state: any) => {
    for (const [key, next] of Object.entries(value)) {
      const current = state[key]
      if (
        current &&
        next &&
        !Array.isArray(current) &&
        !Array.isArray(next) &&
        typeof current === 'object' &&
        typeof next === 'object'
      ) {
        for (const old of Object.keys(current)) delete current[old]
        Object.assign(current, next)
      } else {
        state[key] = next
      }
    }
  })
}

export default defineNuxtPlugin({
  name: 'desktop-plugin-atproto-persistence',
  dependsOn: ['pinia'],
  enforce: 'pre',
  setup(nuxtApp) {
    const pinia = nuxtApp.$pinia
    if (!pinia) return
    const desktopId = resolveDesktopId(nuxtApp)
    const stores = new Map<string, any>()
    const defaults = new Map<string, string>()
    const localWrites = new Map<string, Promise<unknown>>()
    const versions = new Map<string, number>()
    let hydrating = false
    let armed = false
    let booted = false
    let currentDid: string | undefined
    let scopeWarned = false
    let resetTask: Promise<void> | undefined
    let stopSessionWatch: (() => void) | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let syncTask: Promise<void> | undefined
    let restoredActor: string | undefined
    const localKey = (key: string) => toLocalStorageKey(desktopId, key)
    const outboxPrefix = (did: string) => `${desktopId}/outbox/${did}/`

    function authenticatedDid(): string | undefined {
      if (!(nuxtApp as any).$atproto) return undefined
      const { isLogged, session } = nuxtApp.runWithContext(() =>
        useAtprotoSession(),
      )
      return isLogged.value ? session.value?.sub : undefined
    }

    function createQueue() {
      return createAtprotoWriteQueue(
        async (key, value) => {
          const did = authenticatedDid()
          if (!did || did !== currentDid)
            throw new Error('AT Protocol session changed before sync')
          const target = parseAtprotoStoreKey(key, desktopId)
          if (!target) return
          const agent = nuxtApp.runWithContext(() =>
            useAtprotoAgent('authenticated'),
          )
          await putAtprotoApplicationState(
            agent,
            did,
            target.collection,
            target.rkey,
            JSON.parse(value),
          )
          const outboxKey = `${outboxPrefix(did)}${key}`
          // A newer change may have arrived while this request was in flight.
          if ((await get(outboxKey)) === value) await del(outboxKey)
        },
        {
          onError: (error: unknown) => {
            if (!scopeWarned) {
              scopeWarned = true
              console.warn(
                '[OWD persistence] Remote save failed; queued locally for retry. For ScopeMissingError, request the matching repo: permissions in OAuth metadata and sign in again.',
                error,
              )
            }
          },
        },
      )
    }
    let queue = createQueue()

    const adapter = createPersistedStatePlugin({
      persist: false,
      assertStorage: () => {},
      storage: {
        getItem: async (key) => (await get<string>(localKey(key))) ?? null,
        setItem(key, value) {
          if (resetTask) return resetTask
          if (!hydrating) versions.set(key, (versions.get(key) ?? 0) + 1)
          // Capture the actor before entering the async chain: never send a prior
          // account's edit to the account that happens to be logged in later.
          const did = armed && !hydrating ? authenticatedDid() : undefined
          const previous = localWrites.get(key) ?? Promise.resolve()
          const task = previous
            .catch(() => {})
            .then(async () => {
              await set(localKey(key), value)
              if (
                did &&
                did === currentDid &&
                parseAtprotoStoreKey(key, desktopId)
              ) {
                await set(`${outboxPrefix(did)}${key}`, value)
                void queue.enqueue(key, value)
              }
            })
          localWrites.set(key, task)
          return task
        },
        removeItem: async (key) => {
          await del(localKey(key))
        },
      },
    })
    pinia.use((context) => {
      const initial = JSON.stringify(context.store.$state)
      const result = adapter(context)
      if (context.store.$persistedState) {
        stores.set(context.store.$id, context.store)
        defaults.set(context.store.$id, initial)
      }
      return result
    })

    async function syncRemote() {
      await Promise.all(
        [...stores.values()].map((store) => store.$persistedState.isReady()),
      )
      await Promise.all(localWrites.values())
      const baseline = new Map(versions)
      const actor = await resolveRestoreActorDid(nuxtApp)
      const did = authenticatedDid()
      if (currentDid !== did) {
        queue.stop()
        queue = createQueue()
      }
      currentDid = did
      if (restoredActor === (actor ?? 'guest')) return
      try {
        const remote = await ensureActorStatesLoaded(nuxtApp, true)
        // Discard a response fetched for an account/route that changed meanwhile.
        if (
          actor !== (await resolveRestoreActorDid(nuxtApp)) ||
          did !== authenticatedDid()
        )
          return
        await Promise.all(
          [...stores.values()].map((store) => store.$persistedState.isReady()),
        )
        await Promise.all(localWrites.values())
        const applications = nuxtApp.runWithContext(() =>
          useDesktopApplication(),
        )
        hydrating = true
        try {
          for (const [key, store] of stores) {
            const pending = did
              ? await get<string>(`${outboxPrefix(did)}${key}`)
              : undefined
            const value = pending
              ? JSON.parse(pending)
              : remote[mapStoreKey(key)]
            if (!value || (versions.get(key) ?? 0) !== (baseline.get(key) ?? 0))
              continue
            const match = /^desktop\/application\/(.+)\/windows$/.exec(key)
            const app = match ? applications.get(match[1]!) : undefined
            // Close old controllers before replacing their saved state, so no
            // controller retains references to objects detached by hydration.
            app?.closeAllWindows()
            replaceState(store, value as Record<string, any>)
            if (app) await app.restoreApplication()
          }
        } finally {
          // Pinia subscriptions flush on the next Vue tick.
          await nextTick()
          hydrating = false
        }
        await Promise.all(localWrites.values())
        armed = true
        restoredActor = actor ?? 'guest'
        if (did) {
          for (const key of await keys()) {
            if (typeof key !== 'string' || !key.startsWith(outboxPrefix(did)))
              continue
            const value = await get<string>(key)
            if (value != null)
              void queue.enqueue(key.slice(outboxPrefix(did).length), value)
          }
        }
      } catch {
        armed = true
        console.warn(
          '[OWD persistence] Remote restore failed; keeping local windows and retrying.',
        )
        if (!retry)
          retry = setTimeout(() => {
            retry = undefined
            void synchronize()
          }, 5000)
      }
    }

    function synchronize(): Promise<void> {
      if (!booted) return Promise.resolve()
      if (!syncTask)
        syncTask = syncRemote().finally(() => {
          syncTask = undefined
        })
      return syncTask
    }

    // OAuth init is complete at app:created, regardless of how long it took.
    // No store read blocks a plugin that OAuth itself might depend on.
    nuxtApp.hook('app:created', async () => {
      booted = true
      await synchronize()
    })
    const lifecycle = nuxtApp.hook as any
    lifecycle('atproto:sessionCreated', () => synchronize())
    lifecycle('atproto:sessionRestored', () => synchronize())
    function resetPersistence(): Promise<void> {
      if (resetTask) return resetTask
      armed = false
      currentDid = undefined
      restoredActor = undefined
      invalidateActorStates(nuxtApp)
      queue.stop()
      queue = createQueue()
      if (retry) clearTimeout(retry)
      retry = undefined
      const pending = [...localWrites.values()]
      resetTask = (async () => {
        // Let other sign-out hooks close/reset the shell, then discard both
        // their writes and any older writes already in flight.
        await nextTick()
        for (const [key, store] of stores) {
          const initial = defaults.get(key)
          if (initial) replaceState(store, JSON.parse(initial))
        }
        await nextTick()
        await Promise.allSettled(pending)
        for (const key of await keys()) {
          if (typeof key === 'string' && key.startsWith(`${desktopId}/`))
            await del(key)
        }
      })().finally(() => {
        resetTask = undefined
      })
      return resetTask
    }
    lifecycle('atproto:sessionDeleted', resetPersistence)
    nuxtApp.hook('app:mounted', () => {
      const atproto = (nuxtApp as any).$atproto
      if (!atproto) return
      stopSessionWatch = watch(
        () => atproto.status?.value,
        (next, previous) => {
          if (previous === 'authenticated' && next !== 'authenticated')
            void resetPersistence()
        },
      )
    })

    const online = () => {
      void queue.flush()
      void synchronize()
    }
    window.addEventListener('online', online)
    nuxtApp.vueApp.onUnmount?.(() => {
      queue.stop()
      stopSessionWatch?.()
      if (retry) clearTimeout(retry)
      window.removeEventListener('online', online)
    })
  },
})
