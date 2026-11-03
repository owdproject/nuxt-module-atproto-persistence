import { useRuntimeConfig } from 'nuxt/app'
import { useAtprotoAgent, useAtprotoSession } from '#imports'

/** Reversible record-key encoding; AT Protocol permits `~`, but not `/` or `%`. */
export function encodeRecordKeyPart(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) => {
    const char = String.fromCharCode(byte)
    return /[a-zA-Z0-9._-]/.test(char)
      ? char
      : `~${byte.toString(16).padStart(2, '0')}`
  }).join('')
}

function decodeRecordKeyPart(value: string): string {
  return decodeURIComponent(value.replace(/~/g, '%'))
}

/** Resolve PDS endpoint via PLC directory (Bluesky); custom PDSs use the same DID document shape. */
export async function resolveActorServiceEndpoint(
  did: string,
): Promise<string> {
  const response = await fetch(`https://plc.directory/${did}`)

  if (!response.ok) {
    throw new Error('Failed to fetch profile service endpoint')
  }

  const data = await response.json()

  return data.service[0].serviceEndpoint
}

/** Slug used inside rkeys (RecordKey forbids `/`, so desktop state is namespaced with this). */

/**
 * Identity of the desktop distribution that owns the persisted profile.
 *
 * Declared as `id` in `desktop.config.ts` (`defineDesktopConfig({ id: 'atproto-os' })`)
 * and surfaced on `runtimeConfig.public.desktop`. Falling back to the branded
 * title/affix keeps two different OWD distributions from sharing records when an
 * explicit `id` is missing.
 */
export function resolveDesktopId(nuxtApp: any): string {
  const runtimeConfig = nuxtApp.runWithContext(() => useRuntimeConfig())
  const desktop = (runtimeConfig.public?.desktop ?? {}) as Record<string, any>

  if (typeof desktop.id === 'string' && desktop.id.length > 0) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(desktop.id)) {
      throw new Error(
        '[OWD persistence] Invalid desktop id; use 1–64 ASCII letters, digits, dots, underscores or hyphens.',
      )
    }
    return desktop.id
  }

  const branded = [desktop.title, desktop.affix].filter(Boolean).join('-')
  // Legacy hosts keep working, but the exact encoded branding is preserved:
  // unlike a lossy slug, distinct brands cannot collapse to the same key.
  return `legacy-${encodeRecordKeyPart(branded || desktop.name || 'owd')}`
}

/** IndexedDB key for a Pinia store id, scoped to the current desktop distribution. */
export function toLocalStorageKey(desktopId: string, piniaKey: string): string {
  return `${desktopId}/${piniaKey}`
}

/**
 * Maps a Pinia store id to an AT Protocol collection and desktop-scoped rkey.
 *
 * The rkey is prefixed with the desktop id so two different OWD distributions
 * (e.g. "Marco's OWD" vs "Alessio's OWD") never read or overwrite each other's
 * profile, even for the same logged-in user.
 *
 * Key format → AT Proto mapping:
 * - `desktop/application/<appId>/windows` → collection: `org.owdproject.application.windows`, rkey: `<desktopId>:<appId>`
 * - `desktop/application/<appId>/meta`    → collection: `org.owdproject.application.meta`,    rkey: `<desktopId>:<appId>`
 * - `desktop`                             → collection: `org.owdproject.desktop`,              rkey: `<desktopId>`
 * - `desktop/<sub>`                       → collection: `org.owdproject.desktop`,              rkey: `<desktopId>:<sub>`
 *
 * Returns `null` for keys that are not persisted to AT Proto.
 */
export function parseAtprotoStoreKey(
  key: string,
  desktopId: string,
): { collection: string; rkey: string } | null {
  if (key.startsWith('desktop/application/')) {
    const parts = key.split('/')
    const last = parts[parts.length - 1]

    if (last === 'windows' || last === 'meta') {
      const appId = parts.slice(2, -1).join('/')
      return {
        collection: `org.owdproject.application.${last}`,
        rkey: `${desktopId}:${encodeRecordKeyPart(appId)}`,
      }
    }
  }

  if (key === 'desktop' || key.startsWith('desktop/')) {
    if (!key.startsWith('desktop/application/')) {
      const sub = key.slice('desktop/'.length)
      return {
        collection: 'org.owdproject.desktop',
        rkey:
          key === 'desktop'
            ? desktopId
            : `${desktopId}:${encodeRecordKeyPart(sub)}`,
      }
    }
  }

  return null
}

export async function listAtprotoApplicationStateRecords(
  agent: any,
  repo: string,
  collection: string,
) {
  const records: any[] = []
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const { data } = await agent.com.atproto.repo.listRecords({
      repo,
      collection,
      cursor,
      limit: 100,
    })
    records.push(...data.records)
    cursor = data.cursor
    if (cursor && seen.has(cursor))
      throw new Error('AT Protocol returned a repeated records cursor')
    if (cursor) seen.add(cursor)
  } while (cursor)
  return records
}

export function getAtprotoApplicationState(
  agent: any,
  repo: string,
  collection: string,
  rkey: string,
) {
  return agent.com.atproto.repo.getRecord({
    repo,
    collection,
    rkey,
  })
}

export function putAtprotoApplicationState(
  agent: any,
  repo: string,
  collection: string,
  rkey: string,
  record: any,
) {
  return agent.com.atproto.repo.putRecord({
    repo,
    collection,
    rkey,
    record: { ...record, $type: collection },
  })
}

/**
 * Loads the full desktop state map for a given actor from the AT Protocol
 * repository. Returns a map keyed by Pinia store id (`desktop/` prefix).
 *
 * Only records belonging to `desktopId` are considered: rkeys must be exactly
 * `<desktopId>` or start with `<desktopId>:`. Legacy/foreign records are ignored,
 * so opening another distribution's OWD never loads an unrelated profile.
 */
export async function loadActorDesktopStateMap(
  nuxtApp: any,
  actorDid: string,
  desktopId: string,
) {
  const { isLogged, session } = nuxtApp.runWithContext(() =>
    useAtprotoSession(),
  )
  const isOwner = isLogged.value && session.value?.sub === actorDid

  let actorAgent
  if (isOwner) {
    actorAgent = nuxtApp.runWithContext(() => useAtprotoAgent('authenticated'))
  } else {
    const actorServiceEndpoint = await resolveActorServiceEndpoint(actorDid)
    actorAgent = nuxtApp.runWithContext(() =>
      useAtprotoAgent(actorServiceEndpoint),
    )
  }

  const prefix = `${desktopId}:`

  const [
    atprotoActorDesktopList,
    atprotoApplicationWindowsList,
    atprotoApplicationMetaList,
  ] = await Promise.allSettled([
    listAtprotoApplicationStateRecords(
      actorAgent,
      actorDid,
      'org.owdproject.desktop',
    ),
    listAtprotoApplicationStateRecords(
      actorAgent,
      actorDid,
      'org.owdproject.application.windows',
    ),
    listAtprotoApplicationStateRecords(
      actorAgent,
      actorDid,
      'org.owdproject.application.meta',
    ),
  ])

  for (const result of [
    atprotoActorDesktopList,
    atprotoApplicationWindowsList,
    atprotoApplicationMetaList,
  ]) {
    if (result.status === 'rejected') throw result.reason
  }

  const stateMap: Record<string, any> = {}

  if (atprotoActorDesktopList.status === 'fulfilled') {
    for (const record of atprotoActorDesktopList.value) {
      const rkey = record.uri.split('/').pop()
      if (rkey === desktopId) {
        const { $type, ...state } = record.value
        stateMap['owd/desktop'] = state
      } else if (typeof rkey === 'string' && rkey.startsWith(prefix)) {
        const { $type, ...state } = record.value
        stateMap[
          `owd/desktop/${decodeRecordKeyPart(rkey.slice(prefix.length))}`
        ] = state
      }
    }
  }

  if (atprotoApplicationWindowsList.status === 'fulfilled') {
    for (const record of atprotoApplicationWindowsList.value) {
      const rkey = record.uri.split('/').pop()
      if (typeof rkey !== 'string' || !rkey.startsWith(prefix)) continue
      const appId = decodeRecordKeyPart(rkey.slice(prefix.length))
      stateMap[`owd/application/${appId}/windows`] = {
        windows: record.value.windows,
      }
    }
  }

  if (atprotoApplicationMetaList.status === 'fulfilled') {
    for (const record of atprotoApplicationMetaList.value) {
      const rkey = record.uri.split('/').pop()
      if (typeof rkey !== 'string' || !rkey.startsWith(prefix)) continue
      const appId = decodeRecordKeyPart(rkey.slice(prefix.length))
      stateMap[`owd/application/${appId}/meta`] = {
        ...record.value,
      }
    }
  }

  return stateMap
}
