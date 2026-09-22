# Agent Note: Remote namespace service lifecycle method renamed to uninstall

Status: implemented

English | [中文](2026-09-22-remote-namespace-uninstall-rename.zh.md)

## Problem

The remote client's namespace service `RemoteNamespaceService` (`packages/api/gateway/src/client/index.ts`) exposes a lifecycle method `remove(kind, method, token)` that uninstalls a mounted method when a mount is disposed or rolled back. The service's guard `assertMethodAvailable` rejects any remote method name that is a namespace-service field or appears on the service prototype, and `remove` sat on that prototype. When the session remote contribution added `@Remote('remove')` for session deletion, mounting the session contribution threw `client api: method "session/remove" conflicts with its namespace service`, and the whole `dsh-api-remotes` plugin failed to load.

## Decision

The lifecycle method is named `uninstall(kind, method, token)`. Its two call sites — the `ClientRemoteService` namespace-dispose path and the `installMethods` rollback path — call `uninstall`. The wire contract is unchanged: the remote method stays `session/remove`, and the client-facing `sessions.remove()` call is unchanged. The guard is unchanged: `remove` is no longer reserved, while `has`, `empty`, and the remaining service members continue to be rejected as method names.

## Alternatives considered

**Rename the remote method on the wire (for example `session/delete`).** The wire name is a contract shared by the session-controller Host contribution, the generated descriptor, and the client consumer. Renaming it propagates a breaking change across packages to resolve a collision caused only by the gateway client's internal helper.

**Exempt `remove` from the reserved-name guard.** The guard exists to catch a remote method silently shadowing a namespace-service member. Exempting one name leaves the same class of collision open and encodes an exception the guard's tests cannot distinguish from a regression.

## Consequences

A remote method named `remove` mounts and disposes cleanly. The gateway client spec pins both sides: the `has` descriptor still throws `conflicts with its namespace service`, and a `remove` descriptor mounts, then its disposer runs the renamed lifecycle path. A remote method named `uninstall` is now reserved in its place. The e2e lane's `built-lib.e2e.ts` boots the built remotes client bundle, which carries the session contribution, and reproduces the original load failure before the fix.