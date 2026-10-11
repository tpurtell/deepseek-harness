import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { ExecutionWorlds, NoExecutionWorldError, requireRemoteWorkspace, WorldFileSystem, WorldSandbox, WorldSubprocess, type ExecutionWorld } from '../src/index.ts'

function recordingWorld(host: string): { world: ExecutionWorld; calls: string[] } {
  const calls: string[] = []
  const recorder = (kind: string) => new Proxy({}, {
    get(_target, method) {
      return (..._args: unknown[]) => { calls.push(`${kind}.${String(method)}`); return `${host}:${String(method)}` }
    },
  })
  return { calls, world: { host, path: '/work', fs: recorder('fs') as FileSystem, subprocess: recorder('subprocess') as SubprocessRuntime, sandbox: recorder('sandbox') as SandboxProvider } }
}

describe('remote execution boundary', () => {
  it('owns a connection per session, shares it with subagents and expires idle worlds', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ExecutionWorlds)
    const dispose = vi.fn(async () => {})
    const factory = vi.fn(async () => ({ ...recordingWorld('rhea').world, dispose }))
    ctx.executionWorlds.configure(factory)
    const identity = { kind: 'cuteafd-ssh' as const, host: 'rhea', path: '/work' }
    const root = ctx.sessions.create(SessionId('root'), { meta: { cwd: '/work', cuteafd_workspace: identity } })
    const other = ctx.sessions.create(SessionId('other'), { meta: { cwd: '/work', cuteafd_workspace: identity } })
    const child = ctx.sessions.create(SessionId('child'), { meta: { cwd: '/work', cuteafd_workspace: identity, origin: 'subagent', parentSession: root.id } })
    try {
      await ctx.executionWorlds.withHeader(root.header, () => {})
      await ctx.executionWorlds.withHeader(child.header, () => {})
      await ctx.executionWorlds.withHeader(other.header, () => {})
      expect(factory).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(dispose).toHaveBeenCalledTimes(2)
      await ctx.executionWorlds.withHeader(root.header, () => {})
      expect(factory).toHaveBeenCalledTimes(3)
    } finally { await ctx.fiber.dispose(); vi.useRealTimers() }
  })

  it('rejects local headers instead of inventing a remote host', () => {
    expect(() => requireRemoteWorkspace({ cwd: '/work' })).toThrow('remote-only mode requires cuteafd_workspace')
  })

  it('dispatches every primitive and fails closed outside a world', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('sandboxPolicy', { defaultMode: 'read-only' } as never)
    const fibers = [await ctx.plugin(ExecutionWorlds), await ctx.plugin(WorldFileSystem), await ctx.plugin(WorldSubprocess), await ctx.plugin(WorldSandbox)]
    try {
      const { world, calls } = recordingWorld('moa')
      const operations = [
        () => ctx.fs.resolve('/work'), () => ctx.fs.processPath({ targetKey: 'x', displayPath: 'x' } as never),
        () => ctx.fs.processPathFromHostPath('/secret'), () => ctx.fs.fileUrl({} as never),
        () => ctx.fs.contains({} as never, {} as never), () => ctx.fs.stat({} as never),
        () => ctx.fs.lstat('/work'), () => ctx.fs.readText({} as never), () => ctx.fs.streamText({} as never),
        () => ctx.fs.readBytes({} as never, undefined, 10), () => ctx.fs.readByteRange({} as never, { offset: 0, length: 10 }),
        () => ctx.fs.listDir({} as never), () => ctx.fs.writeText({} as never, 'x'),
        () => ctx.fs.editText({} as never, {} as never), () => ctx.fs.watch({} as never, () => {}, new AbortController().signal),
        () => ctx.subprocess.resolveExecutable('rg'), () => ctx.subprocess.terminalEnvironment(),
        () => ctx.subprocess.spawn({} as never), () => ctx.subprocess.spawnTerminal({} as never),
        () => ctx.sandbox.confine([], {} as never),
      ]
      for (const operation of operations) {
        expect(operation).toThrow(NoExecutionWorldError)
        ctx.executionWorlds.run(world, operation)
      }
      expect(calls).toHaveLength(operations.length)
      expect(new Set(calls).size).toBe(operations.length)
    } finally { for (const fiber of fibers.reverse()) await fiber.dispose() }
  })

  it('keeps simultaneous hosts separate across asynchronous continuations', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(ExecutionWorlds)
    try {
      const a = recordingWorld('rhea').world
      const b = recordingWorld('moa').world
      const identities = await Promise.all([a, b].map(world => ctx.executionWorlds.run(world, async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return ctx.executionWorlds.current().host
      })))
      expect(identities).toEqual(['rhea', 'moa'])
      expect(() => ctx.executionWorlds.current()).toThrow(NoExecutionWorldError)
      ctx.executionWorlds.configure(async workspace => workspace.host === 'rhea' ? a : b)
      const header = { version: 4, id: SessionId('remote'), createdAt: 1, cwd: '/work', cuteafd_workspace: { kind: 'cuteafd-ssh' as const, host: 'rhea', path: '/work' } }
      expect(await ctx.executionWorlds.withHeader(header, () => ctx.executionWorlds.current().host)).toBe('rhea')
    } finally { await fiber.dispose() }
  })
})
