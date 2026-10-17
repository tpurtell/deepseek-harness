import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { FileSystem, FsTargetKey, FsVersion, type FsTarget } from '@deepseek-ai/dsh-fs'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolSearch from '@deepseek-ai/dsh-tool-fs-search'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell'
import { ExecutionWorlds, WorldFileSystem, WorldSubprocess, WorldShell } from '../src/index.ts'

class RecordingRemoteFs extends FileSystem {
  readonly calls: string[] = []
  content = 'remote original'
  override async resolve(path: string) {
    this.calls.push('resolve')
    const absolute = posix.resolve('/work', path)
    return { targetKey: FsTargetKey(absolute), displayPath: absolute }
  }
  override processPath(target: FsTarget) { this.calls.push('processPath'); return target.displayPath }
  override fileUrl(target: FsTarget) { return `file://${target.displayPath}` }
  override async stat() { this.calls.push('stat'); return { type: 'file' as const, size: this.content.length, version: FsVersion('v1') } }
  override contains(parent: FsTarget, child: FsTarget) { return child.displayPath.startsWith(parent.displayPath + '/') }
  override async lstat(): Promise<never> { throw new Error('unused lstat') }
  override async streamText(): Promise<never> { throw new Error('unused streamText') }
  override async readBytes(): Promise<never> { throw new Error('unused readBytes') }
  override async readByteRange(): Promise<never> { throw new Error('unused readByteRange') }
  override async listDir() { return [] }
  override async readText() { this.calls.push('readText'); return this.content }
  override async writeText(_target: FsTarget, content: string) {
    this.calls.push('writeText')
    const before = this.content
    this.content = content
    return { operation: 'update' as const, before, after: content, version: FsVersion('v2') }
  }
  override async editText(_target: FsTarget, edit: { oldString: string; newString: string }) {
    this.calls.push('editText')
    const before = this.content
    this.content = before.replace(edit.oldString, edit.newString)
    return { before, after: this.content, version: FsVersion('v3') }
  }
}

class RecordingRemoteShell extends ShellExecutor {
  readonly calls: string[] = []
  override get sandboxMode() { return 'read-only' as const }
  override resolve(request: ShellExecRequest): ShellExecSpec {
    this.calls.push('resolve')
    return { command: request.command, workdir: '/work', stdoutMaxBytes: 1000, timeoutMs: 1000, onExpiry: 'kill', signal: request.signal, sandboxPolicy: request.sandboxPolicy }
  }
  override async execute(spec: ShellExecSpec) {
    this.calls.push(spec.command)
    const empty = { readFrom: (fromByte: number) => ({ text: '', nextOffset: fromByte, lossy: false }) }
    return { status: 'completed' as const, exitCode: 0, signal: null, done: Promise.resolve(), kill: () => false,
      sandbox: { mode: 'read-only' as const, denied: false }, readOutput: () => ({ delta: '', lossy: false }),
      observed: { stdout: empty, stderr: empty }, result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false,
        timeoutMs: spec.timeoutMs, stdout: { text: 'remote shell', truncated: false }, stderr: { text: '', truncated: false },
        sandbox: { mode: 'read-only' as const, denied: false } }) }
  }
}

class RecordingRemoteSubprocess extends SubprocessRuntime {
  readonly commands: string[][] = []
  override async resolveExecutable(command: string) { return `/remote/${command}` }
  override async terminalEnvironment(): Promise<never> { throw new Error('unused terminalEnvironment') }
  override async spawnTerminal(): Promise<never> { throw new Error('unused spawnTerminal') }
  override spawn(spec: Parameters<SubprocessRuntime['spawn']>[0]) {
    this.commands.push([...spec.argv])
    const reader = { readFrom: (fromByte: number) => ({ text: '', nextOffset: fromByte, lossy: false }) }
    return { readOutput: () => ({ delta: '', lossy: false }), observed: { stdout: reader, stderr: reader }, collected: { stdout: reader, stderr: reader }, terminate: () => false,
      done: Promise.resolve({ exitCode: 1, signal: null, aborted: false, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }) } as unknown as ReturnType<SubprocessRuntime['spawn']>
  }
}

describe('mounted standard tools', () => {
  it('routes mounted file, bash and search tools through the calling session world', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => ({ mode: 'read-only', workspaceRoot: '/work' }) } as never)
    ctx.provide('workingDirectory', { ensure: async () => '/work' } as never)
    ctx.provide('shellEnv', { collect: () => ({}) } as never)
    await ctx.plugin(ExecutionWorlds)
    await ctx.plugin(WorldFileSystem)
    await ctx.plugin(WorldSubprocess)
    await ctx.plugin(WorldShell)
    const remoteCtx = new Context()
    await remoteCtx.plugin(RecordingRemoteFs)
    const fs = remoteCtx.fs as RecordingRemoteFs
    await remoteCtx.plugin(RecordingRemoteShell)
    await remoteCtx.plugin(RecordingRemoteSubprocess)
    const shell = remoteCtx.shell as RecordingRemoteShell
    const subprocess = remoteCtx.subprocess as RecordingRemoteSubprocess
    ctx.executionWorlds.configure(async () => ({ host: 'rhea', path: '/work', fs, subprocess, shell, sandbox: {} as never }))
    await ctx.plugin(ToolFs)
    await ctx.plugin(ToolBash)
    await ctx.plugin(ToolSearch, { sampleOverCapGlobResults: false })
    const session = ctx.sessions.create(SessionId('remote-tool'), { meta: { cwd: '/work', cuteafd_workspace: { kind: 'cuteafd-ssh', host: 'rhea', path: '/work' } } })
    const agent = { id: session.id, session }
    try {
      expect(ctx.fs).not.toBe(fs)
      expect(() => ctx.fs.resolve('/agent/.ssh/keys/private')).toThrow('no execution host bound')
      const calls = [
        { name: 'read', arguments: { file_path: 'file.txt' }, primitive: 'readText' },
        { name: 'write', arguments: { file_path: 'file.txt', content: 'remote replacement' }, primitive: 'writeText' },
        { name: 'edit', arguments: { file_path: 'file.txt', old_string: 'replacement', new_string: 'edited' }, primitive: 'editText' },
      ]
      expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(['bash', 'edit', 'glob', 'grep', 'read', 'write'])
      for (const call of calls) {
        const start = fs.calls.length
        const result = await ctx.tools.execute({ ...call, agent: agent as never, callId: ToolCallId(call.name), signal: new AbortController().signal })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
        expect(fs.calls.slice(start), call.name).toContain(call.primitive)
      }
      expect(fs.content).toBe('remote edited')
      const previous = process.env.DSH_REMOTE_ONLY
      process.env.DSH_REMOTE_ONLY = '1'
      try {
        for (const call of [
          { name: 'bash', arguments: { command: 'printf remote', description: 'Check remote shell routing' } },
          { name: 'grep', arguments: { pattern: 'needle' } },
          { name: 'glob', arguments: { pattern: '*.ts' } },
        ]) {
          const result = await ctx.tools.execute({ ...call, agent: agent as never, callId: ToolCallId(call.name), signal: new AbortController().signal })
          expect(result.isError, JSON.stringify(result)).not.toBe(true)
        }
        expect(shell.calls).toContain('printf remote')
        expect(subprocess.commands).toHaveLength(2)
        expect(subprocess.commands.every(argv => argv[0] === '/remote/rg')).toBe(true)
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, 'DSH_REMOTE_ONLY')
        else process.env.DSH_REMOTE_ONLY = previous
      }
    } finally { await ctx.fiber.dispose(); await remoteCtx.fiber.dispose() }
  })
})
