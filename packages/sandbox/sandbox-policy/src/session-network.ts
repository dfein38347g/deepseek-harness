/**
 * Per-session network-axis lock: the session log as the store. The lock is
 * NOT a runtime switch: the preset-mounted network-lock plugin
 * (`./network-lock.ts`) is its only writer, recording exactly one
 * `sandbox/network` event when the session is published, so there is no
 * runtime channel — no event endpoint, no per-call parameter, no model
 * choice, no `sandbox_permissions` escape — through which a looser axis can
 * later be recorded. Like the `sandbox/mode` override, the last such event
 * is the session's state: an override survives restart by replay, two
 * sessions can never see each other's state, and there is no external
 * config store. The event is log-only (the `approval/*` precedent): NOT a
 * surface event, carries no `surfaceOp`, and is never in the model
 * transcript.
 *
 * The fold into resolved policy lives in the policy service's
 * `sandboxNetwork` session-projection unit; executors see only the resolved
 * axis via {@link SandboxExecutionPolicy.network} and the model-facing
 * policy context.
 *
 * The lock is policy state shared by every enforcing family, so it lives
 * here in the policy package rather than in any one capability's seam.
 *
 * @module dsh-sandbox-policy/session-network
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { SandboxNetworkMode } from '@deepseek-ai/dsh-sandbox'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's network-axis lock was recorded — log-only (like
     * `sandbox/mode`; NOT a surface event, carries no `surfaceOp`):
     * durable and replayable, never in the model transcript. The LAST such
     * event is the session's lock (folded by the sandboxNetwork projection
     * unit). The preset-mounted network-lock plugin is the only writer.
     */
    'sandbox/network': {
      network: SandboxNetworkMode
    }
  }
}

/**
 * THE write path for a session's network-axis lock: appends exactly one
 * `sandbox/network` event — the lock IS its event; nothing mutates network
 * state out of band. The network-lock plugin is the only caller. Takes
 * effect on the session's next policy resolution (every enforcing
 * capability and the model-facing policy context read the shared
 * projection state).
 * @param session - the session the lock belongs to.
 * @param network - the axis every subsequent policy resolution in this
 *   session resolves to (until the next lock).
 */
export function setSandboxNetwork(session: Session, network: SandboxNetworkMode): void {
  session.append('sandbox/network', { network })
}
