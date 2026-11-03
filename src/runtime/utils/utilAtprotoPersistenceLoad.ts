import { useAtprotoSession } from '#imports'
import { useRouter, useRuntimeConfig } from 'nuxt/app'
import {
  loadActorDesktopStateMap,
  resolveDesktopId,
} from './utilAtprotoApplicationStates'

export async function resolveRestoreActorDid(
  nuxtApp: any,
): Promise<string | undefined> {
  const router = nuxtApp.runWithContext(() => useRouter())
  await router.isReady()
  const routeDid = router.currentRoute.value.params.did
  if (typeof routeDid === 'string' && routeDid.length > 0) return routeDid
  if (!nuxtApp.$atproto) return undefined

  const { isLogged, session } = nuxtApp.runWithContext(() =>
    useAtprotoSession(),
  )
  if (isLogged.value && session.value?.sub) return session.value.sub

  const desktop = nuxtApp.runWithContext(() => useRuntimeConfig()).public
    .desktop as any
  if (desktop.atprotoPersistence?.loadOwnerDesktopOnMounted)
    return desktop.atprotoDesktop?.owner?.did
  return undefined
}

// Per Nuxt app and actor, not a module-global promise shared by unrelated hosts.
// Failed reads are never cached, so online/session hooks can retry them.
const loads = new WeakMap<
  object,
  Map<string, Promise<Record<string, unknown>>>
>()

export async function ensureActorStatesLoaded(
  nuxtApp: any,
  refresh = false,
): Promise<Record<string, unknown>> {
  const actorDid = await resolveRestoreActorDid(nuxtApp)
  if (!actorDid) return {}
  const desktopId = resolveDesktopId(nuxtApp)
  let cache = loads.get(nuxtApp)
  if (!cache) loads.set(nuxtApp, (cache = new Map()))
  const key = `${desktopId}/${actorDid}`
  if (refresh) cache.delete(key)
  if (!cache.has(key)) {
    const task = loadActorDesktopStateMap(nuxtApp, actorDid, desktopId).catch(
      (error) => {
        cache!.delete(key)
        throw error
      },
    )
    cache.set(key, task)
  }
  return cache.get(key)!
}

/** Invalidate this host's remote profile when its account signs out. */
export function invalidateActorStates(nuxtApp: object): void {
  loads.delete(nuxtApp)
}
