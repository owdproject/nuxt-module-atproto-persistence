import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive } from 'vue'
import { createPinia, defineStore, setActivePinia } from 'pinia'
const env = vi.hoisted(() => ({
  values: new Map<string, string>(),
  did: undefined as string | undefined,
  put: vi.fn(),
  list: vi.fn(),
  applications: new Map<string, any>(),
}))
vi.mock('idb-keyval', () => ({
  get: async (key: string) => env.values.get(key),
  set: async (key: string, value: string) => {
    env.values.set(key, value)
  },
  del: async (key: string) => {
    env.values.delete(key)
  },
  keys: async () => [...env.values.keys()],
}))
vi.mock('nuxt/app', () => ({
  defineNuxtPlugin: (plugin: any) => plugin,
  useRuntimeConfig: () => ({ public: { desktop: { id: 'atproto-os' } } }),
  useRouter: () => ({
    isReady: async () => {},
    currentRoute: { value: { params: {} } },
  }),
}))
vi.mock('#imports', () => ({
  useAtprotoSession: () => ({
    isLogged: { value: !!env.did },
    session: { value: env.did ? { sub: env.did } : undefined },
  }),
  useAtprotoAgent: () => ({
    com: { atproto: { repo: { listRecords: env.list, putRecord: env.put } } },
  }),
}))
vi.mock('@owdproject/nuxt/runtime/composables/useDesktopApplication', () => ({
  useDesktopApplication: () => ({
    get: (id: string) => env.applications.get(id),
  }),
}))
import plugin from '../src/runtime/plugin'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
it('waits for OAuth completion, restores remote windows and persists closing them through an offline retry', async () => {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  const hooks = new Map<string, Function[]>()
  const cleanups: Function[] = []
  const pinia = createPinia()
  const nuxt: any = {
    vueApp: { onUnmount: (fn: Function) => cleanups.push(fn) },
    $pinia: pinia,
    runWithContext: (fn: Function) => fn(),
    hook(name: string, fn: Function) {
      hooks.set(name, [...(hooks.get(name) ?? []), fn])
    },
  }
  env.values.clear()
  env.applications.clear()
  env.did = undefined
  env.put
    .mockReset()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({})
  const saved = { model: 'main', state: { id: 'restored' }, meta: {} }
  env.list.mockReset().mockImplementation(async ({ collection }) => ({
    data: {
      records: collection.endsWith('.windows')
        ? [
            {
              uri: `at://alice/${collection}/atproto-os:org.test`,
              value: { windows: { restored: saved } },
            },
          ]
        : [],
    },
  }))
  ;(plugin as any).setup(nuxt)
  createApp({}).use(pinia)
  setActivePinia(pinia)
  const useWindows = defineStore(
    'desktop/application/org.test/windows',
    () => ({ windows: reactive<Record<string, any>>({}) }),
    { persistedState: { persist: true } } as any,
  )
  const store = useWindows() as any
  await store.$persistedState.isReady()
  expect(env.list).not.toHaveBeenCalled()
  // OAuth completes later than the old two-second deadline, before app:created.
  vi.useFakeTimers()
  await vi.advanceTimersByTimeAsync(3000)
  env.did = 'did:plc:alice'
  nuxt.$atproto = {}
  const app = {
    closeAllWindows: vi.fn(() => {
      for (const key of Object.keys(store.windows)) delete store.windows[key]
    }),
    restoreApplication: vi.fn(),
  }
  env.applications.set('org.test', app)
  for (const callback of hooks.get('app:created')!) await callback()
  expect(store.windows.restored).toEqual(saved)
  expect(app.restoreApplication).toHaveBeenCalledOnce()
  // A repeated session-restored hook must not reopen a just-closed window.
  delete store.windows.restored
  await nextTick()
  await vi.advanceTimersByTimeAsync(0)
  expect(env.put).toHaveBeenCalledOnce()
  expect([...env.values.keys()].some((key) => key.includes('/outbox/'))).toBe(
    true,
  )
  for (const callback of hooks.get('atproto:sessionRestored')!) await callback()
  expect(store.windows).toEqual({})
  await vi.advanceTimersByTimeAsync(5000)
  expect(env.put).toHaveBeenCalledTimes(2)
  expect(env.put.mock.calls[1][0].record.windows).toEqual({})
  expect([...env.values.keys()].some((key) => key.includes('/outbox/'))).toBe(
    false,
  )
  env.did = undefined
  await Promise.all(
    hooks.get('atproto:sessionDeleted')!.map((callback) => callback()),
  )
  expect(store.windows).toEqual({})
  expect(
    [...env.values.keys()].filter((key) => key.startsWith('atproto-os/')),
  ).toEqual([])
  for (const callback of cleanups) await callback()
})
