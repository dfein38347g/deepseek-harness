/**
 * Tests for the preset network-lock plugin (the `./network-lock` subpath):
 * the static mount-time row that locks every session the mounting agent
 * publishes to the network `none`, a documented no-op under an
 * `inherit`/absent configuration, and a throw for any other value — the
 * only writer of the `sandbox/network` event in the system.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import * as networkLock from '@deepseek-ai/dsh-sandbox-policy/src/network-lock.ts'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

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

async function lockedContext(deployment: { network?: 'inherit' | 'none' }, lockConfig: { network?: 'inherit' | 'none' }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, deployment)
  networkLock.apply(ctx, lockConfig)
  return ctx
}

describe('the network-lock plugin', () => {
  it('locks every session the mounting context publishes to network none', async () => {
    const ctx = await lockedContext({ network: 'inherit' }, { network: 'none' })
    const first = session('lock-a')
    const second = session('lock-b')
    ctx.emit('session/created', first)
    ctx.emit('session/created', second)
    for (const locked of [first, second]) {
      const events = locked.snapshotEvents().filter(event => event.type === 'sandbox/network')
      expect(events).toHaveLength(1)
      expect(ctx.sandboxPolicy.resolve({ session: locked }).network).toBe('none')
    }
  })

  it('an inherit or absent configuration is a documented no-op', async () => {
    const lockConfigs: { network?: 'inherit' | 'none' }[] = [{ network: 'inherit' }, {}]
    for (const lockConfig of lockConfigs) {
      const ctx = await lockedContext({ network: 'inherit' }, lockConfig)
      const idle = session('noop')
      ctx.emit('session/created', idle)
      expect(idle.snapshotEvents().filter(event => event.type === 'sandbox/network')).toHaveLength(0)
      expect(ctx.sandboxPolicy.resolve({ session: idle }).network).toBe('inherit')
    }
  })

  it('a deployment already on none keeps a locked session on none (the stricter of the two wins)', async () => {
    const ctx = await lockedContext({ network: 'none' }, { network: 'none' })
    const locked = session('dep-none')
    ctx.emit('session/created', locked)
    expect(ctx.sandboxPolicy.resolve({ session: locked }).network).toBe('none')
  })

  it('an unvalidated axis value throws at mount instead of silently releasing a quarantine preset', () => {
    const ctx = new Context()
    expect(() => {
      networkLock.apply(ctx, { network: 'yolo' as never })
    }).toThrow(/must be 'inherit' or 'none'/)
  })
})
