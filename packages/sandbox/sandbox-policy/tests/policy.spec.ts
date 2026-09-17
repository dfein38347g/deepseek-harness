/**
 * Tests for the sandbox-policy home: the deployment default (mode +
 * network axis + workspaceRoot) the service exposes, and the per-session
 * `sandbox/mode` override kit (fold + write path) every enforcing
 * capability reads.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicyService, { SANDBOX_MODES, setSandboxMode, setSandboxNetwork } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'

async function mounted(config: { mode?: 'read-only' | 'workspace-write' | 'danger-full-access'; network?: 'inherit' | 'none'; workspaceRoot?: string } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, config)
  return ctx
}

function session(id: string, cwd?: string): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    isSeeded: false,
    ...cwd === undefined ? {} : { cwd },
  })
}

function agentFor(activeSession: Session): Agent {
  return { session: activeSession } as unknown as Agent
}

async function policyContext(ctx: Context, activeSession: Session): Promise<string | undefined> {
  return (await ctx.systemPrompt.assemble({ agent: agentFor(activeSession) }))
    .contexts.find(context => context.name === 'sandbox:policy')?.text
}

describe('SandboxPolicyService', () => {
  it('defaults to read-only under the process cwd', async () => {
    const ctx = await mounted()
    expect(ctx.sandboxPolicy.defaultMode).toBe('read-only')
    expect(ctx.sandboxPolicy.defaultNetwork).toBe('inherit')
    expect(ctx.sandboxPolicy.workspaceRoot).toBe(resolve(process.cwd()))
  })

  it('carries a configured mode and resolves the workspace root absolute', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/ws/../ws/./sub', network: 'inherit' })
    expect(ctx.sandboxPolicy.defaultMode).toBe('workspace-write')
    expect(ctx.sandboxPolicy.workspaceRoot).toBe(resolve('/ws/../ws/./sub'))
  })

  it('resolves the deployment policy for an agentless call', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback', network: 'inherit' })
    expect(ctx.sandboxPolicy.resolve()).toEqual({
      mode: 'workspace-write',
      workspaceRoot: resolve('/fallback'), network: 'inherit',
    })
  })

  it('resolves each session mode and cwd together without changing the fallback', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback', network: 'inherit' })
    const first = session('sess-first', '/projects/first')
    const second = session('sess-second', '/projects/second')
    setSandboxMode(second, 'read-only')

    expect(ctx.sandboxPolicy.resolve({ session: first })).toEqual({
      mode: 'workspace-write',
      workspaceRoot: resolve('/projects/first'), network: 'inherit',
      sessionId: 'sess-first',
    })
    expect(ctx.sandboxPolicy.resolve({ session: second })).toEqual({
      mode: 'read-only',
      workspaceRoot: resolve('/projects/second'), network: 'inherit',
      sessionId: 'sess-second',
    })
    expect(ctx.sandboxPolicy.overrideOf(first)).toBeUndefined()
    expect(ctx.sandboxPolicy.overrideOf(second)).toBe('read-only')
    expect(ctx.sandboxPolicy.resolve()).toEqual({
      mode: 'workspace-write',
      workspaceRoot: resolve('/fallback'), network: 'inherit',
    })
  })

  it.skipIf(process.platform === 'win32')('resolves a symlink-sensitive session cwd with POSIX component semantics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-policy-cwd-'))
    try {
      const lexical = join(root, 'lexical')
      const physical = join(root, 'physical')
      const child = join(physical, 'child')
      mkdirSync(lexical)
      mkdirSync(child, { recursive: true })
      const link = join(lexical, 'link')
      symlinkSync(child, link, 'dir')
      const cwd = `${link}${sep}..`
      const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback', network: 'inherit' })

      expect(ctx.sandboxPolicy.resolve({ session: session('sess-symlink-parent', cwd) })).toEqual({
        mode: 'workspace-write',
        workspaceRoot: realpathSync.native(physical), network: 'inherit',
        sessionId: 'sess-symlink-parent',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lets an approved mode outrank the session mode while retaining its root', async () => {
    const ctx = await mounted({ workspaceRoot: '/fallback' })
    const active = session('sess-approved', '/projects/approved')
    setSandboxMode(active, 'read-only')
    expect(ctx.sandboxPolicy.resolve({ session: active, mode: 'danger-full-access' })).toEqual({
      mode: 'danger-full-access',
      workspaceRoot: resolve('/projects/approved'), network: 'inherit',
      sessionId: 'sess-approved',
    })
  })

  it('uses the configured root when a session has no cwd', async () => {
    const ctx = await mounted({ workspaceRoot: '/fallback' })
    expect(ctx.sandboxPolicy.resolve({ session: session('sess-no-cwd') }).workspaceRoot).toBe(resolve('/fallback'))
  })

  it('resolves the deployment network axis on every call, never as a per-call override', async () => {
    const ctx = await mounted({ network: 'none' })
    expect(ctx.sandboxPolicy.defaultNetwork).toBe('none')
    const active = session('sess-none', '/projects/none')
    expect(ctx.sandboxPolicy.resolve()).toEqual({
      mode: 'read-only',
      network: 'none',
      workspaceRoot: resolve(process.cwd()),
    })
    expect(ctx.sandboxPolicy.resolve({ session: active })).toEqual({
      mode: 'read-only',
      network: 'none',
      workspaceRoot: resolve('/projects/none'),
      sessionId: 'sess-none',
    })
    // An approved per-call MODE override outranks the session and the
    // deployment default, but the axis stays the deployment value.
    expect(ctx.sandboxPolicy.resolve({ session: active, mode: 'workspace-write' }).network).toBe('none')
  })

  it('rejects a network axis outside the closed union at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    // schemastery rejects the union violation when the plugin loads.
    await expect(ctx.plugin(SandboxPolicyService, { network: 'yolo' as never })).rejects.toThrow()
  })

  it('rejects a mode outside the closed vocabulary at load', async () => {
    const ctx = new Context()
    // Config validation runs when the fiber activates, and the policy seam
    // requires the projection registry (mandatory injection) to activate.
    await ctx.plugin(SessionProjectionRegistry)
    // schemastery rejects the union violation when the plugin loads.
    await expect(ctx.plugin(SandboxPolicyService, { mode: 'yolo' as never })).rejects.toThrow()
  })

  it('disposes the service and context contribution from a child fiber (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = await ctx.plugin(SandboxPolicyService, {})
    expect(ctx.sandboxPolicy).toBeDefined()
    expect(await policyContext(ctx, session('sess-hmr'))).toContain('read-only')
    await fiber.dispose()
    expect(ctx.get('sandboxPolicy')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).contexts.find(context => context.name === 'sandbox:policy')).toBeUndefined()
  })
})

describe('sandbox:policy request context', () => {
  async function promptMounted(config: { mode?: 'read-only' | 'workspace-write' | 'danger-full-access'; network?: 'inherit' | 'none'; workspaceRoot?: string } = {}): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, config)
    return ctx
  }

  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)('renders the exact %s policy without a capability inventory', async (mode) => {
    const ctx = await promptMounted({ mode, workspaceRoot: '/fallback' })
    const workspaceRoot = resolve('/projects/current')
    const expected = {
      'read-only': 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.',
      'workspace-write': `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(workspaceRoot)}. Some platform temporary areas may also be writable.`,
      'danger-full-access': 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.',
    } as const

    expect(await policyContext(ctx, session(`sess-${mode}`, '/projects/../projects/current'))).toBe(expected[mode])
  })

  it('keeps the complete rendered prompt byte-stable across TMPDIR changes', async () => {
    const ctx = await promptMounted({ mode: 'workspace-write' })
    const active = session('sess-tmpdir-stability', '/projects/current')
    const previous = process.env.TMPDIR
    try {
      process.env.TMPDIR = '/tmp/first-host-temp'
      const firstAssembly = await ctx.systemPrompt.assemble({ agent: agentFor(active) })
      const firstPrompt = renderPrompt(firstAssembly)
      const firstContext = renderContextSnapshot(firstAssembly)
      process.env.TMPDIR = '/tmp/second-host-temp'
      const secondAssembly = await ctx.systemPrompt.assemble({ agent: agentFor(active) })
      expect(renderPrompt(secondAssembly)).toBe(firstPrompt)
      expect(renderContextSnapshot(secondAssembly)).toBe(firstContext)
      expect(firstContext).not.toContain('host-temp')
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }
  })

  it('reflects the latest durable switch on the next assembly and stays byte-stable otherwise', async () => {
    const ctx = await promptMounted()
    const active = session('sess-switch', '/projects/current')
    const first = await policyContext(ctx, active)
    expect(await policyContext(ctx, active)).toBe(first)

    setSandboxMode(active, 'danger-full-access')
    const danger = await policyContext(ctx, active)
    expect(danger).toBe('Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.')
    expect(await policyContext(ctx, active)).toBe(danger)

    setSandboxMode(active, 'workspace-write')
    expect(await policyContext(ctx, active)).toBe(`Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(resolve('/projects/current'))}. Some platform temporary areas may also be writable.`)
  })

  it('reconstructs resumed policy from the session log and omits diagnostics without an agent', async () => {
    const active = session('sess-resume', '/projects/current')
    setSandboxMode(active, 'workspace-write')
    const resumed = Session.create(active.id, active.snapshotEvents(), active.header)
    const ctx = await promptMounted({ mode: 'read-only' })

    expect(await policyContext(ctx, resumed)).toContain('workspace-write')
    expect((await ctx.systemPrompt.assemble()).contexts.find(context => context.name === 'sandbox:policy')?.text).toBe('')
  })

  it('appends the network stance to the context only when the deployment axis is none', async () => {
    const ctx = await promptMounted({ mode: 'read-only', workspaceRoot: '/fallback', network: 'none' })
    const active = session('sess-net-none', '/projects/current')
    expect(await policyContext(ctx, active)).toBe(
      'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. '
      + 'Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns. '
      + 'Current DSH network policy: none. This session\'s confined processes run in a fresh, empty network namespace: no interfaces, no routes, no DNS — network access is structurally unavailable and network attempts fail. '
      + 'Unix-socket paths that remain visible in the filesystem view are the only exception by construction.',
    )
  })

  it('appends the network stance to the context for a session the preset locked, although the deployment axis is inherit', async () => {
    const ctx = await promptMounted({ mode: 'read-only', workspaceRoot: '/fallback' })
    const active = session('sess-net-locked', '/projects/current')
    setSandboxNetwork(active, 'none')
    expect(await policyContext(ctx, active)).toBe(
      'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. '
      + 'Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns. '
      + 'Current DSH network policy: none. This session\'s confined processes run in a fresh, empty network namespace: no interfaces, no routes, no DNS — network access is structurally unavailable and network attempts fail. '
      + 'Unix-socket paths that remain visible in the filesystem view are the only exception by construction.',
    )
  })
})

describe('the sandbox/mode session kit', () => {
  it('SANDBOX_MODES lists every mode for advertisement and validation', () => {
    expect(SANDBOX_MODES).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  })

  it('the sandboxMode projection folds to the last switch, or null without one', async () => {
    const ctx = await mounted()
    const session = Session.create(SessionId('sess-fold'))
    expect(ctx.sessionProjections.stateOf(session, 'sandboxMode')).toBeNull()
    setSandboxMode(session, 'workspace-write')
    setSandboxMode(session, 'read-only')
    expect(ctx.sessionProjections.stateOf(session, 'sandboxMode')).toBe('read-only')
  })

  it('setSandboxMode appends exactly one sandbox/mode event per switch', () => {
    const session = Session.create(SessionId('sess-write'))
    setSandboxMode(session, 'danger-full-access')
    const modeEvents = session.snapshotEvents().filter(e => e.type === 'sandbox/mode')
    expect(modeEvents).toHaveLength(1)
    expect(modeEvents[0]?.data).toEqual({ mode: 'danger-full-access' })
  })
})

describe('the sandbox/network session kit (the preset lock)', () => {
  it('setSandboxNetwork appends exactly one sandbox/network event per lock', () => {
    const session = Session.create(SessionId('sess-net-lock'))
    setSandboxNetwork(session, 'none')
    const networkEvents = session.snapshotEvents().filter(e => e.type === 'sandbox/network')
    expect(networkEvents).toHaveLength(1)
    expect(networkEvents[0]?.data).toEqual({ network: 'none' })
  })

  it('the sandboxNetwork projection folds to the last lock, or null without one', async () => {
    const ctx = await mounted()
    const session = Session.create(SessionId('sess-net-fold'))
    expect(ctx.sessionProjections.stateOf(session, 'sandboxNetwork')).toBeNull()
    setSandboxNetwork(session, 'none')
    setSandboxNetwork(session, 'inherit')
    setSandboxNetwork(session, 'none')
    expect(ctx.sessionProjections.stateOf(session, 'sandboxNetwork')).toBe('none')
  })

  it('a preset lock tightens a session to none over a deployment inherit, and never loosens a deployment none', async () => {
    const inherit = await mounted()
    const locked = session('sess-locked', '/projects/locked')
    setSandboxNetwork(locked, 'none')
    expect(inherit.sandboxPolicy.resolve({ session: locked })).toEqual({
      mode: 'read-only',
      network: 'none',
      workspaceRoot: resolve('/projects/locked'),
      sessionId: 'sess-locked',
    })
    // The lock is per session: a sibling session of the same deployment stays inherit.
    expect(inherit.sandboxPolicy.resolve({ session: session('sess-unlocked', '/projects/other') }).network).toBe('inherit')
    expect(inherit.sandboxPolicy.resolve().network).toBe('inherit')

    const deploymentNone = await mounted({ network: 'none' })
    const relaxed = session('sess-relaxed', '/projects/relaxed')
    setSandboxNetwork(relaxed, 'inherit')
    expect(deploymentNone.sandboxPolicy.resolve({ session: relaxed }).network).toBe('none')
  })

  it('an approved mode override leaves the locked network axis untouched', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback' })
    const active = session('sess-locked-mode', '/projects/locked-mode')
    setSandboxNetwork(active, 'none')
    expect(ctx.sandboxPolicy.resolve({ session: active, mode: 'read-only' })).toEqual({
      mode: 'read-only',
      network: 'none',
      workspaceRoot: resolve('/projects/locked-mode'),
      sessionId: 'sess-locked-mode',
    })
  })

  it('reconstructs a resumed session network lock from the session log', async () => {
    const active = session('sess-resumed-lock', '/projects/current')
    setSandboxNetwork(active, 'none')
    const resumed = Session.create(active.id, active.snapshotEvents(), active.header)
    const ctx = await mounted()
    expect(ctx.sandboxPolicy.resolve({ session: resumed }).network).toBe('none')
  })
})
