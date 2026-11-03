<p align="center">
  <img width="160" height="160" src="https://avatars.githubusercontent.com/u/201536780?s=160&v=4" />
</p>
<h1 align="center">ATProto Persistence Module</h1>
<h3 align="center">
  Hybrid Pinia persistence for Open Web Desktop: local-first with AT Protocol sync.
</h3>

## Overview

This module registers a Pinia persisted-state adapter backed by **IndexedDB**
(`idb-keyval`) with optional sync to the user's AT Protocol repository. It
replaces `@owdproject/nuxt-module-pinia-persistence` — **do not install both** in the same
desktop.

Boot order is handled without core coupling: the plugin runs in Nuxt's **pre**
phase (registers the adapter only). Stores hydrate locally first. Remote hydration runs at `app:created`, after
the `atproto` OAuth plugin has finished initialization. The Nuxt application
controllers await `$persistedState.isReady()` before restoring local windows.

## Requirements

- The matching `@owdproject/nuxt` adapter revision with persisted store opt-ins
  and `ApplicationController.restoreApplication()` (release these together).
- `@owdproject/nuxt-module-atproto` (provides OAuth session and agents)

### OAuth scope

The special `atproto` scope only covers identity. Writing the desktop profile to
the repository requires explicit **`repo:`** permissions *with actions* (the PDS
checks `action=create`/`action=update` for `putRecord`), otherwise the write is
rejected (403 / `ScopeMissingError`):

```ts
// desktop/nuxt.config.ts
const ACTIONS = 'action=create&action=update&action=delete'
atproto: {
  oauth: {
    signInOptions: { scope: `atproto repo:org.owdproject.desktop?${ACTIONS} repo:org.owdproject.application.windows?${ACTIONS} repo:org.owdproject.application.meta?${ACTIONS}` },
    clientMetadata: { local: { scope: `atproto repo:org.owdproject.desktop?${ACTIONS} repo:org.owdproject.application.windows?${ACTIONS} repo:org.owdproject.application.meta?${ACTIONS}` } },
  },
}
```

You can use `repo:*?action=create&action=update&action=delete` instead to grant
access to every record type. Changing the scope requires signing in again
(existing sessions keep their original grant).

## Installation

```bash
pnpm desktop add nuxt-module-atproto-persistence
```

## Configuration

```ts
// desktop/desktop.config.ts
export default defineDesktopConfig({
  modules: [
    '@owdproject/nuxt-module-atproto',
    '@owdproject/nuxt-module-atproto-persistence',
  ],
  atprotoPersistence: {
    // Load atprotoDesktop.owner.did remote state on boot (not only /actor/:did)
    loadOwnerDesktopOnMounted: false,
  },
})
```

## Actor resolution (remote hydrate)

After plugin initialization, remote state is fetched when an actor DID is
resolved:

1. Route `/actor/:did` — view another actor's desktop
2. Logged-in session — `session.sub`
3. `loadOwnerDesktopOnMounted: true` — `atprotoDesktop.owner.did`
4. Otherwise — IndexedDB only

## Desktop scoping

Persisted state is namespaced by the **desktop distribution id**, declared as
`id` in `desktop.config.ts`:

```ts
export default defineDesktopConfig({
  id: 'atproto-os',
  // ...
})
```

The id is resolved from `runtimeConfig.public.desktop.id` (falling back to the
reversibly encoded branded title/affix, then `name`). It prefixes the AT Protocol record rkeys and
the local IndexedDB keys, so products configured with distinct stable ids do not share a profile.
Using the same id deliberately shares that namespace for the same account. Records that do not carry the current desktop prefix are ignored.

## AT Protocol collections

| Pinia store id | AT Proto collection | rkey |
|---|---|---|
| `desktop` | `org.owdproject.desktop` | `<desktopId>` |
| `desktop/<sub>` | `org.owdproject.desktop` | `<desktopId>:<encoded sub>` |
| `desktop/application/<appId>/windows` | `org.owdproject.application.windows` | `<desktopId>:<encoded appId>` |
| `desktop/application/<appId>/meta` | `org.owdproject.application.meta` | `<desktopId>:<encoded appId>` |

When logged in, mapped keys are written to the repo on change (`putRecord`).
Unmapped keys stay local-only. Local IndexedDB keys are `<desktopId>/<pinia store id>`.

## Sign-out

On sign-out the module forgets the cached remote state map and wipes the local
IndexedDB keys for the desktop (`atproto:sessionDeleted`, or the
`authenticated → anonymous` transition). The desktop shell is expected to close
its windows on the same lifecycle event so the next account never inherits the
previous one's layout (see the atproto OS host plugin
`atproto-reset-on-signout.client.ts`).

## Restore and delivery guarantees

The adapter registers synchronously before stores are created. Stores first
hydrate from IndexedDB. Remote hydration runs at `app:created`, after OAuth
initialization finishes, without treating a slow login as a guest session.
Session changes and network recovery can retry failed reads. Remote hydration
keeps changes made locally while a read was in flight, and a repeated session
hook does not reopen closed windows.

Authenticated changes are saved to a desktop/account-scoped IndexedDB outbox.
Remote writes are serialized per store; failures retry after five seconds or
on network recovery. An entry is removed only after a successful write of that
value. Pending entries survive reloads and take precedence over older remote
records. This is snapshot persistence, not real-time collaboration; Jetstream
integration remains separate.

Explicit desktop ids preserve case and punctuation and must contain 1–64 ASCII
letters, digits, dots, underscores or hyphens, starting with a letter or digit.
Use a stable explicit id for each distribution. Hosts without one retain a
reversibly encoded branding fallback; changing that branding changes the profile
namespace. Record-key components encode reserved characters reversibly, including
multi-segment store ids. Reads paginate through all collection records.

Run `pnpm run test:persistence` after installing dev dependencies to verify the
identity mapping, pagination, slow OAuth, remote restore and offline write retry.

## License

This module is released under the [MIT License](LICENSE).
