/** Session-selected execution capabilities. The harness has no local execution world. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FileSystem } from '@deepseek-ai/dsh-fs'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

export interface ExecutionWorld {
  readonly host: string
  readonly path: string
  readonly fs: FileSystem
  readonly subprocess: SubprocessRuntime
  readonly sandbox: SandboxProvider
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
  if (workspace.kind !== 'cuteafd-ssh' || workspace.path !== header.cwd) throw new Error('invalid remote workspace identity')
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
    try { return await this.run(await entry.world, operation) } finally {
      entry.active--
      if (entry.active === 0 && this.worlds.get(owner.id) === entry) {
        entry.timer = setTimeout(() => { void this.release(owner.id) }, 60_000)
        entry.timer.unref()
      }
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
  override spawn(...args: Parameters<SubprocessRuntime['spawn']>) { return this.backend.spawn(...args) }
  override spawnTerminal(...args: Parameters<SubprocessRuntime['spawnTerminal']>) { return this.backend.spawnTerminal(...args) }
}

export class WorldSandbox extends SandboxProvider {
  static inject = ['executionWorlds']
  override confine(...args: Parameters<SandboxProvider['confine']>) { return this.ctx.executionWorlds.current().sandbox.confine(...args) }
}

export const name = 'cuteafd-execution-worlds'
export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(ExecutionWorlds)
  await ctx.plugin(WorldFileSystem)
  await ctx.plugin(WorldSubprocess)
  await ctx.plugin(WorldSandbox)
}
