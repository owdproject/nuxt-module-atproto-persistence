import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAtprotoWriteQueue } from '../src/runtime/utils/utilAtprotoWriteQueue'

const env = vi.hoisted(() => ({
  desktop: { id: 'atproto-os' } as any,
  did: 'did:plc:alice',
  agent: {} as any,
}))
vi.mock('nuxt/app', () => ({
  useRuntimeConfig: () => ({ public: { desktop: env.desktop } }),
}))
vi.mock('#imports', () => ({
  useAtprotoSession: () => ({
    isLogged: { value: true },
    session: { value: { sub: env.did } },
  }),
  useAtprotoAgent: () => env.agent,
}))
import {
  encodeRecordKeyPart,
  resolveDesktopId,
  parseAtprotoStoreKey,
  loadActorDesktopStateMap,
} from '../src/runtime/utils/utilAtprotoApplicationStates'

const app = { runWithContext: (fn: () => any) => fn() }
afterEach(() => vi.useRealTimers())
beforeEach(() => {
  env.desktop = { id: 'atproto-os' }
})

it('preserves explicit identities and rejects ambiguous invalid ids', () => {
  env.desktop.id = 'foo.bar'
  expect(resolveDesktopId(app)).toBe('foo.bar')
  env.desktop.id = 'foo-bar'
  expect(resolveDesktopId(app)).toBe('foo-bar')
  env.desktop.id = 'bad/id'
  expect(() => resolveDesktopId(app)).toThrow('Invalid desktop id')
})

it('round-trips multi-segment store keys without mixing desktop profiles or legacy records', async () => {
  const source = [
    'desktop',
    'desktop/workspace',
    'desktop/nuxt-fs/explorer',
    'desktop/application/org.test/app/windows',
  ]
  const records = source.map((key) => ({
    key,
    ...parseAtprotoStoreKey(key, 'atproto-os')!,
  }))
  expect(encodeRecordKeyPart('a/b~c')).toBe('a~2fb~7ec')
  expect(records[2].rkey).not.toBe(
    parseAtprotoStoreKey('desktop/nuxt-fs', 'atproto-os')!.rkey,
  )
  env.agent = {
    com: {
      atproto: {
        repo: {
          listRecords: vi.fn(async ({ collection, cursor }) => ({
            data: cursor
              ? {
                  records: records
                    .filter((r) => r.collection === collection)
                    .map((r) => ({
                      uri: `at://${env.did}/${collection}/${r.rkey}`,
                      value: { marker: r.key, windows: { saved: {} } },
                    })),
                }
              : {
                  records: [
                    {
                      uri: `at://${env.did}/${collection}/other:app`,
                      value: {},
                    },
                    { uri: `at://${env.did}/${collection}/self`, value: {} },
                  ],
                  cursor: 'page2',
                },
          })),
        },
      },
    },
  }
  const result = await loadActorDesktopStateMap(app, env.did, 'atproto-os')
  expect(Object.keys(result).sort()).toEqual(
    [
      'owd/desktop',
      'owd/desktop/workspace',
      'owd/desktop/nuxt-fs/explorer',
      'owd/application/org.test/app/windows',
    ].sort(),
  )
  expect(env.agent.com.atproto.repo.listRecords).toHaveBeenCalledTimes(6)
})

it('surfaces failed reads instead of caching an empty remote profile', async () => {
  env.agent = {
    com: {
      atproto: {
        repo: { listRecords: vi.fn().mockRejectedValue(new Error('offline')) },
      },
    },
  }
  await expect(
    loadActorDesktopStateMap(app, env.did, 'atproto-os'),
  ).rejects.toThrow('offline')
})

it('retries an unchanged failed write and serializes newer changes behind an in-flight request', async () => {
  vi.useFakeTimers()
  const write = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined)
  const queue = createAtprotoWriteQueue(write, { retryMs: 10 })
  await queue.enqueue('windows', 'closed')
  await vi.advanceTimersByTimeAsync(10)
  expect(write.mock.calls).toEqual([
    ['windows', 'closed'],
    ['windows', 'closed'],
  ])
  await queue.enqueue('windows', 'closed')
  expect(write).toHaveBeenCalledTimes(2)
  queue.stop()

  let release!: () => void
  const slow = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          release = r
        }),
    )
    .mockResolvedValue(undefined)
  const serial = createAtprotoWriteQueue(slow)
  const first = serial.enqueue('windows', 'opened')
  serial.enqueue('windows', 'moved')
  serial.enqueue('windows', 'closed')
  release()
  await first
  expect(slow.mock.calls).toEqual([
    ['windows', 'opened'],
    ['windows', 'closed'],
  ])
  serial.stop()
})
