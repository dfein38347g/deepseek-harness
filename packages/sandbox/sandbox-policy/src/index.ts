/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the network axis ({@link SandboxNetworkMode}), the
 * `workspace-write` root, and the override kit. The mode override is the
 * `sandbox/mode` event and its fold (the `sandboxMode` session-projection
 * unit registered here; the event and write path come from
 * `./session-mode.ts`). The network lock is the `sandbox/network` event and
 * its fold (the `sandboxNetwork` projection unit registered here; the
 * write path in `./session-network.ts`), whose ONLY writer is the
 * preset-mounted `./network-lock.ts` plugin — a static preset row, never a
 * runtime decision.
 * Before each agent request, the owner also contributes the resolved policy to
 * the cache-safe runtime-context snapshot. The agent loop logs that snapshot as
 * model history, so replay reconstructs the same mode and root the enforcing
 * consumers resolve without rewriting the stable system prompt.
 *
 * Enforcing filesystem, one-shot bash, and terminal backends read the SAME
 * resolved policy here. The context describes that policy without inventorying
 * capabilities, while each backend retains its own enforcement dialect and each
 * tool owns its operation-specific denial and escalation guidance. The service
 * reads session state once at each operation boundary; executors and providers
 * remain session-free.
 *
 * @module @deepseek-ai/dsh-sandbox-policy
 */

import { resolve as resolvePath } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { canonicalPath, type SandboxExecutionPolicy, type SandboxMode, type SandboxNetworkMode } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'

export { SANDBOX_MODES, setSandboxMode } from './session-mode.ts'
export { setSandboxNetwork } from './session-network.ts'

/** Resolve filesystem identity before lexical normalization can erase symlink-sensitive components. */
function resolveWorkspaceRoot(path: string): string {
  return resolvePath(canonicalPath(path))
}

/** Render the policy without claiming which capabilities are mounted. */
function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  let text: string
  switch (policy.mode) {
    case 'read-only':
      text = 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
      break
    case 'workspace-write':
      text = `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.`
      break
    case 'danger-full-access':
      text = 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
      break
    /* v8 ignore next 4 -- SandboxMode is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const mode: never = policy.mode
      throw new Error(`unreachable sandbox mode: ${String(mode)}`)
    }
  }
  return policy.network === 'none'
    ? `${text} Current DSH network policy: none. This session's confined processes run in a fresh, empty network namespace: no interfaces, no routes, no DNS — network access is structurally unavailable and network attempts fail. Unix-socket paths that remain visible in the filesystem view are the only exception by construction.`
    : text
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }
}

/**
 * Plugin config: the deployment's sandbox default. All optional — `Config`
 * supplies the defaults (`mode: 'read-only'` is the fail-safe default; a
 * deployment that wants a workspace-writable agent opts in explicitly). The
 * runner choice is NOT here (it is the `ctx.sandbox` provider's config), nor
 * is any per-family knob: this is the one shared policy home.
 */
export interface Config {
  /** File-sandbox mode a session starts from (default: `read-only`). */
  mode?: SandboxMode
  /**
   * Fallback root for agentless calls and sessions without a cwd (default:
   * `process.cwd()`). Normal agent calls use their session cwd instead.
   */
  workspaceRoot?: string
  /**
   * Network axis every confined process in this deployment runs under
   * (default: `inherit` — the historical behavior, in which file
   * confinement never claimed the network). `none` moves each confined
   * process into a fresh, empty network namespace: no routes, no
   * interfaces, no DNS. The axis is DEPLOYMENT-LEVEL by design: this
   * value is the deployment floor, a preset may additionally lock its own
   * sessions to `none` by mounting the `./network-lock` plugin (the only
   * per-session writer — it can only tighten, never loosen), and the axis
   * is deliberately NOT a per-call override, a model choice, or an
   * `sandbox_permissions` escape hatch. Enforceability is the runner's
   * business: bubblewrap expresses it (`--unshare-net`); the other rungs
   * fail closed.
   */
  network?: SandboxNetworkMode
}

/** Inputs that select the sandbox policy for one capability call. */
export interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}

/** The sandbox-mode projection's state schema (state equals the public shape). */
const sandboxModeStateSchema = zod.union([
  zod.literal('read-only'),
  zod.literal('workspace-write'),
  zod.literal('danger-full-access'),
]).nullable()

type SandboxModeState = zod.infer<typeof sandboxModeStateSchema>

/** The network-axis projection's state schema (state equals the public shape). */
const sandboxNetworkStateSchema = zod.union([
  zod.literal('inherit'),
  zod.literal('none'),
]).nullable()

type SandboxNetworkState = zod.infer<typeof sandboxNetworkStateSchema>
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Last logged sandbox-mode override, or null before one (deployment default applies at resolve time). */
    sandboxMode: SandboxModeState
    /** Last logged network-axis lock, or null before one (the deployment floor applies at resolve time). */
    sandboxNetwork: SandboxNetworkState
  }
}

/**
 * The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
 * default mode, the network axis, the fallback workspace root, and the
 * current request-time policy section. Tool layers call {@link resolve} for
 * each execution so a session's mode log, network lock, and immutable cwd
 * travel together to every enforcing capability.
 */
export class SandboxPolicyService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
    // No schema default: process.cwd() is resolved in the constructor so the
    // stored root is always absolute regardless of how it was supplied.
    workspaceRoot: z.string(),
    network: z.union(['inherit', 'none'] as const).default('inherit'),
  })

  static inject = ['sessionProjections']

  /** The deployment default mode — the fallback beneath a session override. */
  readonly defaultMode: SandboxMode
  /**
   * The deployment network axis — the deployment-level floor; a preset's
   * mount-time network lock may pin individual sessions further to `none`,
   * never per call.
   */
  readonly defaultNetwork: SandboxNetworkMode
  /** The absolute `workspace-write` fallback root for calls without a session cwd. */
  readonly workspaceRoot: string
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // schemastery (static Config) already filled `mode`; the cast records that
    // runtime fact. `workspaceRoot` has NO schema default, so its fallback to
    // the process cwd is real branching, resolved absolute either way.
    this.defaultMode = config.mode as SandboxMode
    this.defaultNetwork = config.network as SandboxNetworkMode
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())

    ctx.sessionProjections.register({
      key: 'sandboxMode',
      stateVersion: 1,
      stateSchema: sandboxModeStateSchema,
      init: () => null,
      apply: (state, event) => (event.type === 'sandbox/mode' ? event.data.mode : state),
    })

    ctx.sessionProjections.register({
      key: 'sandboxNetwork',
      stateVersion: 1,
      stateSchema: sandboxNetworkStateSchema,
      init: () => null,
      apply: (state, event) => (event.type === 'sandbox/network' ? event.data.network : state),
    })

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'sandbox:policy',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY'),
        text: (context) => {
          const session = context.agent?.session
          return session === undefined
            ? ''
            : renderPolicyContext(this.resolve({ session }))
        },
      })
    })
  }

  /**
   * Resolve the complete policy for one capability call. An approved explicit
   * mode outranks the session's last `sandbox/mode` event, which outranks the
   * deployment default. A session cwd is its workspace-write boundary; the
   * configured root is the fallback for agentless calls and sessions without a
   * cwd. The network axis resolves to the stricter of the deployment floor
   * and the session's preset network lock — deliberately NOT a per-call
   * override, a model choice, or a runtime switch.
   * @param request - optional session and approved mode override.
   * @returns the fully resolved per-call mode, network axis, and absolute workspace root.
   */
  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request
    return {
      mode: request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode,
      network: this.networkOf(session),
      workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),
      ...session === undefined ? {} : { sessionId: session.id },
    }
  }

  /**
   * Read the session override without applying the deployment default.
   * @param session - session whose log supplies the override.
   * @returns the last logged mode, or `undefined` without one.
   */
  overrideOf(session: Session): SandboxMode | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'sandboxMode') ?? undefined
  }

  /**
   * Resolve the network axis for one call: the stricter of the deployment
   * floor and the session's last `sandbox/network` event (the preset network
   * lock). `none` wins from either source, so a lock tightens but never
   * loosens, and an agentless call runs under the deployment axis alone.
   * @param session - session whose log may carry the preset lock, or
   *   `undefined` for an agentless call.
   * @returns the axis every confined process in this call runs under.
   */
  private networkOf(session: Session | undefined): SandboxNetworkMode {
    if (this.defaultNetwork === 'none') return 'none'
    if (session === undefined) return this.defaultNetwork
    return this.ctx.sessionProjections.stateOf(session, 'sandboxNetwork') ?? this.defaultNetwork
  }
}

export default SandboxPolicyService
