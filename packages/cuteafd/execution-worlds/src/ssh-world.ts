/** One isolated SSH capability set per owning session, never a host-global pool. */
import { Context } from '@deepseek-ai/cordis'
import { SshConnection, type Config } from '@deepseek-ai/dsh-ssh'
import SshFileSystem from '@deepseek-ai/dsh-fs-ssh'
import SshSubprocessRuntime from '@deepseek-ai/dsh-subprocess-ssh'
import SshSandboxProvider from '@deepseek-ai/dsh-sandbox-ssh'
import type { WorldFactory } from './index.ts'

export type HostConfiguration = (alias: string) => Promise<Config>

export function sshWorldFactory(ctx: Context, hostConfiguration: HostConfiguration): WorldFactory {
  return async (workspace, header) => {
    const config = await hostConfiguration(workspace.host)
    let child = ctx
    for (const name of ['ssh', 'fs', 'subprocess', 'sandbox']) child = child.isolate(name)
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
      return { host: workspace.host, path: header.cwd ?? workspace.path, fs: child.get('fs') as SshFileSystem, subprocess: child.get('subprocess') as SshSubprocessRuntime, sandbox: child.get('sandbox') as SshSandboxProvider, dispose }
    } catch (error) {
      await dispose()
      throw new Error(`SSH host ${JSON.stringify(workspace.host)} unavailable; no local execution fallback`, { cause: error })
    }
  }
}
