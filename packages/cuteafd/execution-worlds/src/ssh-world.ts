/** One isolated SSH capability set per owning session, never a host-global pool. */
import { Context } from '@deepseek-ai/cordis'
import { SshConnection, type Config } from '@deepseek-ai/dsh-ssh'
import SshFileSystem from '@deepseek-ai/dsh-fs-ssh'
import SshSubprocessRuntime from '@deepseek-ai/dsh-subprocess-ssh'
import SshSandboxProvider from '@deepseek-ai/dsh-sandbox-ssh'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { NodePtcRuntime } from '@deepseek-ai/dsh-ptc-runtime-node'
import type { WorldFactory } from './index.ts'

export type HostConfiguration = (alias: string) => Promise<Config>

/** Keep session-owned providers in their isolated scope when routed services trace their callers. */
function ownedCapability<T extends object>(value: T): T {
  const original = Reflect.get(value, Symbol.for('cordis.original')) as T | undefined
  const provider = original ?? value
  const methods = new Map<PropertyKey, unknown>()
  return new Proxy(provider, {
    get(target, key) {
      if (key === Symbol.for('cordis.tracker')) return undefined
      const member = Reflect.get(target, key, target)
      if (typeof member !== 'function') return member
      if (!methods.has(key)) methods.set(key, member.bind(target))
      return methods.get(key)
    },
  })
}

export function sshWorldFactory(ctx: Context, hostConfiguration: HostConfiguration): WorldFactory {
  return async (workspace, header) => {
    const config = await hostConfiguration(workspace.host)
    // Service calls carry the caller's dependency shadow; new providers need their own injection scope.
    const shadow = Symbol.for('cordis.shadow')
    let child: Context = Object.hasOwn(ctx, shadow) ? Object.getPrototypeOf(ctx) as Context : ctx
    for (const name of ['ssh', 'fs', 'subprocess', 'sandbox', 'shell', 'ptcRuntime']) child = child.isolate(name)
    const fibers = [
      child.plugin(SshConnection, { ...config, workspace: workspace.path, leaseMs: 15_000 }),
      child.plugin(SshFileSystem),
      child.plugin(SshSubprocessRuntime),
      child.plugin(SshSandboxProvider),
    ]
    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    }
    try {
      await Promise.all(fibers)
      const ssh = child.get('ssh') as SshConnection
      await ssh.ready
      const shell = child.plugin(SandboxBashExecutor, {})
      const ptc = child.plugin(NodePtcRuntime, { launch: ssh.ptcLaunch })
      fibers.push(shell, ptc)
      await Promise.all([shell, ptc])
      return {
        host: workspace.host, path: header.cwd ?? workspace.path,
        fs: ownedCapability(child.get('fs') as SshFileSystem),
        subprocess: ownedCapability(child.get('subprocess') as SshSubprocessRuntime),
        sandbox: ownedCapability(child.get('sandbox') as SshSandboxProvider),
        shell: ownedCapability(child.get('shell') as SandboxBashExecutor),
        ptcRuntime: ownedCapability(child.get('ptcRuntime') as NodePtcRuntime),
        dispose,
      }
    } catch (error) {
      await dispose()
      throw new Error(`SSH host ${JSON.stringify(workspace.host)} unavailable; no local execution fallback`, { cause: error })
    }
  }
}
