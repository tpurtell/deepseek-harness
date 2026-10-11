/** Session-selected execution capabilities. The harness has no local execution world. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FileSystem } from '@deepseek-ai/dsh-fs'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
export { sshWorldFactory } from './ssh-world.ts'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

export interface ExecutionWorld {
  readonly host: string
  readonly path: string
  readonly fs: FileSystem
  readonly subprocess: SubprocessRuntime
  readonly sandbox: SandboxProvider
  readonly shell?: ShellExecutor
  readonly ptcRuntime?: PtcRuntime
  readonly dispose?: () => Promise<void>
}

export class NoExecutionWorldError extends Error {
  constructor() {
    super('no execution host bound to this call')
    this.name = 'NoExecutionWorldError'
  }
}

export class RemoteWorkspaceRequiredError extends Error {
  constructor() {
    super('remote-only mode requires cuteafd_workspace; local sessions cannot be opened')
    this.name = 'RemoteWorkspaceRequiredError'
  }
}

export function requireRemoteWorkspace(header: Pick<SessionHeader, 'cwd' | 'cuteafd_workspace'>): NonNullable<SessionHeader['cuteafd_workspace']> {
  const workspace = header.cuteafd_workspace
  if (workspace === undefined) throw new RemoteWorkspaceRequiredError()
  if (workspace.kind !== 'cuteafd-ssh' || workspace.path !== header.cwd
    || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(workspace.host)
    || !workspace.path.startsWith('/') || workspace.path.includes('\0')) throw new Error('invalid remote workspace identity')
  return workspace
}

export type WorldFactory = (workspace: NonNullable<SessionHeader['cuteafd_workspace']>, header: SessionHeader) => Promise<ExecutionWorld>

interface WorldEntry {
  readonly world: Promise<ExecutionWorld>
  active: number
  timer?: NodeJS.Timeout
}

declare module '@deepseek-ai/cordis' {
  interface Context { executionWorlds: ExecutionWorlds }
}

export class ExecutionWorlds extends Service {
  static inject = ['sessions']
  private readonly currentWorld = new AsyncLocalStorage<ExecutionWorld>()
  private readonly worlds = new Map<SessionId, WorldEntry>()
  private readonly owners = new WeakMap<ExecutionWorld, SessionId>()
  private closing = false
  private factory: WorldFactory | undefined

  constructor(ctx: Context) {
    super(ctx, 'executionWorlds')
    ctx.on('tools/execute', (exec, next) => {
      if (exec.agent === undefined) throw new NoExecutionWorldError()
      return this.within(exec.agent, next)
    }, { prepend: true })
    ctx.on('agent/pre-step', ({ agent }, next) => this.within(agent, next), { prepend: true })
    ctx.on('gateway/execute', (args, next) => {
      for (const value of args) {
        if (typeof value !== 'object' || value === null) continue
        if ('executionHeader' in value && value.executionHeader !== undefined) {
          return this.withHeader(value.executionHeader as SessionHeader, next)
        }
        if ('session' in value && typeof value.session === 'object' && value.session !== null && 'header' in value.session) {
          return this.withHeader(value.session.header as SessionHeader, next)
        }
      }
      return next()
    }, { prepend: true })
    ctx.on('session/disposed', session => this.release(session.id))
    ctx.effect(() => async () => {
      this.closing = true
      await Promise.all([...this.worlds.keys()].map(id => this.release(id)))
    })
  }

  configure(factory: WorldFactory): void {
    if (this.factory !== undefined) throw new Error('execution world factory already configured')
    this.factory = factory
  }

  current(): ExecutionWorld {
    const world = this.currentWorld.getStore()
    if (world === undefined) throw new NoExecutionWorldError()
    return world
  }

  run<T>(world: ExecutionWorld, operation: () => T): T {
    return this.currentWorld.run(world, operation)
  }

  async within<T>(agent: Pick<Agent, 'id' | 'session'>, operation: () => T): Promise<Awaited<T>> {
    return await this.withHeader(agent.session.header, operation)
  }

  async withHeader<T>(header: SessionHeader, operation: () => T): Promise<Awaited<T>> {
    const workspace = requireRemoteWorkspace(header)
    if (this.closing) throw new NoExecutionWorldError()
    let owner = header
    const seen = new Set<SessionId>()
    while (owner.origin === 'subagent' && owner.parentSession !== undefined) {
      if (seen.has(owner.id)) throw new Error('cyclic remote session ownership')
      seen.add(owner.id)
      const parent = this.ctx.sessions.get(owner.parentSession)?.header
      if (parent === undefined) throw new Error('remote subagent parent is not open')
      const parentWorkspace = requireRemoteWorkspace(parent)
      if (parentWorkspace.host !== workspace.host) throw new Error('remote subagent cannot change its execution host')
      owner = parent
    }
    let entry = this.worlds.get(owner.id)
    if (entry === undefined) {
      if (this.factory === undefined) throw new NoExecutionWorldError()
      entry = { world: this.factory(workspace, owner), active: 0 }
      this.worlds.set(owner.id, entry)
      const pending = entry
      void pending.world.catch(() => { if (this.worlds.get(owner.id) === pending) this.worlds.delete(owner.id) })
    }
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.active++
    try {
      const world = await entry.world
      this.owners.set(world, owner.id)
      return await this.run(world, operation)
    } finally { this.finish(owner.id, entry) }
  }

  /** Live process/PTY handles retain their owner's connection beyond the call boundary. */
  retainUntil(done: Promise<unknown>): void {
    const owner = this.owners.get(this.current())
    const entry = owner === undefined ? undefined : this.worlds.get(owner)
    if (entry === undefined || owner === undefined) return
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.active++
    void done.then(() => this.finish(owner, entry), () => this.finish(owner, entry))
  }

  private finish(owner: SessionId, entry: WorldEntry): void {
    entry.active--
    if (entry.active === 0 && this.worlds.get(owner) === entry) {
      entry.timer = setTimeout(() => { void this.release(owner).catch(() => {}) }, 60_000)
      entry.timer.unref()
    }
  }

  private async release(id: SessionId): Promise<void> {
    const entry = this.worlds.get(id)
    if (entry === undefined) return
    this.worlds.delete(id)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    const world = await entry.world.catch(() => undefined)
    await world?.dispose?.()
  }
}

export class WorldFileSystem extends FileSystem {
  static inject = ['executionWorlds', 'sandboxPolicy']
  private get backend(): FileSystem { return this.ctx.executionWorlds.current().fs }
  override get sandboxMode() { return this.ctx.sandboxPolicy.defaultMode }
  override resolve(...args: Parameters<FileSystem['resolve']>) { return this.backend.resolve(...args) }
  override processPath(...args: Parameters<FileSystem['processPath']>) { return this.backend.processPath(...args) }
  override processPathFromHostPath(...args: Parameters<FileSystem['processPathFromHostPath']>) { return this.backend.processPathFromHostPath(...args) }
  override fileUrl(...args: Parameters<FileSystem['fileUrl']>) { return this.backend.fileUrl(...args) }
  override contains(...args: Parameters<FileSystem['contains']>) { return this.backend.contains(...args) }
  override stat(...args: Parameters<FileSystem['stat']>) { return this.backend.stat(...args) }
  override lstat(...args: Parameters<FileSystem['lstat']>) { return this.backend.lstat(...args) }
  override readText(...args: Parameters<FileSystem['readText']>) { return this.backend.readText(...args) }
  override streamText(...args: Parameters<FileSystem['streamText']>) { return this.backend.streamText(...args) }
  override readBytes(...args: Parameters<FileSystem['readBytes']>) { return this.backend.readBytes(...args) }
  override readByteRange(...args: Parameters<FileSystem['readByteRange']>) { return this.backend.readByteRange(...args) }
  override listDir(...args: Parameters<FileSystem['listDir']>) { return this.backend.listDir(...args) }
  override writeText(...args: Parameters<FileSystem['writeText']>) { return this.backend.writeText(...args) }
  override editText(...args: Parameters<FileSystem['editText']>) { return this.backend.editText(...args) }
  override watch(...args: Parameters<FileSystem['watch']>) { return this.backend.watch(...args) }
}

export class WorldSubprocess extends SubprocessRuntime {
  static inject = ['executionWorlds']
  private get backend(): SubprocessRuntime { return this.ctx.executionWorlds.current().subprocess }
  override resolveExecutable(...args: Parameters<SubprocessRuntime['resolveExecutable']>) { return this.backend.resolveExecutable(...args) }
  override terminalEnvironment(...args: Parameters<SubprocessRuntime['terminalEnvironment']>) { return this.backend.terminalEnvironment(...args) }
  override spawn(...args: Parameters<SubprocessRuntime['spawn']>) {
    const handle = this.backend.spawn(...args)
    this.ctx.executionWorlds.retainUntil(handle.done)
    return handle
  }
  override spawnTerminal(...args: Parameters<SubprocessRuntime['spawnTerminal']>) {
    return this.backend.spawnTerminal(...args).then(handle => {
      this.ctx.executionWorlds.retainUntil(handle.done)
      return handle
    })
  }
}

export class WorldSandbox extends SandboxProvider {
  static inject = ['executionWorlds']
  override confine(...args: Parameters<SandboxProvider['confine']>) { return this.ctx.executionWorlds.current().sandbox.confine(...args) }
}

export class WorldShell extends ShellExecutor {
  static inject = ['executionWorlds', 'sandboxPolicy']
  private get backend(): ShellExecutor {
    const shell = this.ctx.executionWorlds.current().shell
    if (shell === undefined) throw new Error('remote shell unavailable; no local fallback')
    return shell
  }
  override get sandboxMode() { return this.ctx.sandboxPolicy.defaultMode }
  override resolve(...args: Parameters<ShellExecutor['resolve']>) { return this.backend.resolve(...args) }
  override execute(...args: Parameters<ShellExecutor['execute']>) {
    return this.backend.execute(...args).then(handle => {
      this.ctx.executionWorlds.retainUntil(handle.done)
      return handle
    })
  }
}

export class WorldPtcRuntime extends PtcRuntime {
  static inject = ['executionWorlds', 'sandboxPolicy']
  readonly language = 'typescript'
  readonly isolation = 'process'
  override get executionInstructions() { return 'Each call runs in a fresh process on the session SSH host, under the session sandbox policy.' }
  override get sandboxMode() { return this.ctx.sandboxPolicy.defaultMode }
  override get timeout() { return { defaultMs: 120_000, maxMs: 600_000 } }
  private get backend(): PtcRuntime {
    const runtime = this.ctx.executionWorlds.current().ptcRuntime
    if (runtime === undefined) throw new Error('remote PTC runtime unavailable; no local fallback')
    return runtime
  }
  override resolve(...args: Parameters<PtcRuntime['resolve']>) { return this.backend.resolve(...args) }
  override run(...args: Parameters<PtcRuntime['run']>) { return this.backend.run(...args) }
}

export const name = 'cuteafd-execution-worlds'
export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(ExecutionWorlds)
  await ctx.plugin(WorldFileSystem)
  await ctx.plugin(WorldSubprocess)
  await ctx.plugin(WorldSandbox)
  await ctx.plugin(WorldShell)
  await ctx.plugin(WorldPtcRuntime)
}
