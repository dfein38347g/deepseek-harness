/**
 * The preset network lock: an air-gap mounted once, at preset definition,
 * for every session a mounting agent publishes.
 *
 * A quarantine-style agent preset mounts this plugin row with
 * `network: 'none'`. The row's own fiber then subscribes to session
 * publication and appends one `sandbox/network` event to each session the
 * mounting agent enters; the policy service's `sandboxNetwork` projection
 * unit folds the last such event into that session's resolved policy, so
 * from its first confined call on (and in its model-facing policy context)
 * the session resolves the network axis as `none` — a fresh, empty network
 * namespace, no interfaces, no routes, no DNS — even where the deployment
 * axis is `inherit`.
 *
 * The lock is fail-CLOSED by construction: it is static preset composition,
 * not a runtime decision. There is no event endpoint, per-call parameter,
 * approval flow, model tool, or `sandbox_permissions` value that records a
 * looser axis; the only values accepted here are the two of
 * {@link SandboxNetworkMode}, and any other value throws at mount instead
 * of silently releasing a quarantine preset. The event is the entire
 * state, so it is log-only and survives a restart by session-log replay —
 * a resumed session is still locked — and is never in the model
 * transcript.
 *
 * Mounting this row with `network: 'inherit'` (or no value) is a
 * documented no-op: the composition stays a valid lock shape that a later
 * preset revision can tighten without changing the row's identity.
 *
 * @module dsh-sandbox-policy/network-lock
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SandboxNetworkMode } from '@deepseek-ai/dsh-sandbox'
import { setSandboxNetwork } from './session-network.ts'

export const name = 'sandbox-network-lock'

/** The network-lock row config. */
export interface Config {
  /**
   * The axis this preset's sessions are locked to: `none` locks,
   * `inherit` (or an absent value) mounts the documented no-op. Any other
   * value throws at mount.
   */
  network?: SandboxNetworkMode
}

export function apply(ctx: Context, config: Config = {}): void {
  // The runtime value is widened once (config rows are data, and a bad
  // row must fail closed at mount, not loosen a quarantine preset):
  const network = config.network as string | undefined
  if (network === undefined || network === 'inherit') return
  if (network !== 'none') {
    throw new Error(`sandbox-network-lock: config.network must be 'inherit' or 'none', got ${network} — a lock row is static preset composition, never a runtime switch`)
  }
  ctx.on('session/created', (session: Session) => {
    setSandboxNetwork(session, 'none')
  })
}
