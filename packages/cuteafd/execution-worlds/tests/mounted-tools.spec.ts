import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { FileSystem, FsTargetKey, FsVersion, type FsTarget } from '@deepseek-ai/dsh-fs'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { ExecutionWorlds, WorldFileSystem } from '../src/index.ts'

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

describe('mounted standard tools', () => {
  it('routes shared preset read/write/edit closures through the calling session world', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => ({ mode: 'read-only', workspaceRoot: '/work' }) } as never)
    ctx.provide('workingDirectory', { ensure: async () => '/work' } as never)
    await ctx.plugin(ExecutionWorlds)
    await ctx.plugin(WorldFileSystem)
    const remoteCtx = new Context()
    await remoteCtx.plugin(RecordingRemoteFs)
    const fs = remoteCtx.fs as RecordingRemoteFs
    ctx.executionWorlds.configure(async () => ({ host: 'rhea', path: '/work', fs, subprocess: {} as never, sandbox: {} as never }))
    await ctx.plugin(ToolFs)
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
      expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(calls.map(call => call.name).sort())
      for (const call of calls) {
        const start = fs.calls.length
        const result = await ctx.tools.execute({ ...call, agent: agent as never, callId: ToolCallId(call.name), signal: new AbortController().signal })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
        expect(fs.calls.slice(start), call.name).toContain(call.primitive)
      }
      expect(fs.content).toBe('remote edited')
    } finally { await ctx.fiber.dispose(); await remoteCtx.fiber.dispose() }
  })
})
