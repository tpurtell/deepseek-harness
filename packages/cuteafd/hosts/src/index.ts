/** Operator-owned SSH identities; no model tool receives deployment paths or keys. */
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { Config as SshConfig } from '@deepseek-ai/dsh-ssh'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { sshWorldFactory } from '@cuteafd/dsh-execution-worlds'
import type {} from '@cuteafd/dsh-execution-worlds'
import type {} from '@deepseek-ai/dsh-workspace'

const exec = promisify(execFile)
const aliasSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u)
const hostSchema = z.object({
  alias: aliasSchema,
  hostname: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u),
  user: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u),
  port: z.number().int().min(1).max(65535),
}).strict()
export type HostSpec = z.infer<typeof hostSchema>
interface HostRecord extends HostSpec { knownHosts: string; helper?: string | undefined; helperHash?: string | undefined }
export interface HostView extends HostSpec { confirmed: boolean }
export interface Config { home?: string; helperRoot: string }
export type Runner = (command: string, args: readonly string[], input?: string | Uint8Array) => Promise<string>

export const run: Runner = async (command, args, input) => {
  if (input === undefined) {
    const result = await exec(command, [...args], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    return result.stdout
  }
  return await new Promise<string>((accept, reject) => {
    const child = execFile(command, [...args], { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => error === null ? accept(stdout) : reject(error))
    child.stdin?.end(input)
  })
}
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const configQuote = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

export function hostKeyFingerprint(key: string): string {
  if (/[\r\n\0]/u.test(key)) throw new Error('unsupported host key')
  const fields = key.trim().split(/\s+/u)
  if (fields.length !== 3 || fields[1] !== 'ssh-ed25519' || !/^[a-zA-Z0-9+/]+={0,2}$/u.test(fields[2]!)) throw new Error('unsupported host key')
  const blob = Buffer.from(fields[2]!, 'base64')
  if (blob.length !== 51 || blob.readUInt32BE(0) !== 11 || blob.subarray(4, 15).toString() !== 'ssh-ed25519' || blob.readUInt32BE(15) !== 32) throw new Error('unsupported host key')
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}`
}

const knownHostName = (spec: HostSpec): string => spec.port === 22 ? spec.hostname : `[${spec.hostname}]:${spec.port}`

export function sshConfig(records: readonly HostRecord[], home: string): string {
  return records.map(record => `Host ${record.alias}\n  HostName ${record.hostname}\n  User ${record.user}\n  Port ${record.port}\n  IdentityFile ${configQuote(join(home, '.ssh/keys', record.alias))}\n  UserKnownHostsFile ${configQuote(join(home, '.ssh/known_hosts'))}\n  GlobalKnownHostsFile /dev/null\n  IdentitiesOnly yes\n  BatchMode yes\n  StrictHostKeyChecking yes\n  ForwardAgent no\n  ClearAllForwardings yes\n  ConnectTimeout 10\n  ServerAliveInterval 5\n  ServerAliveCountMax 2\n`).join('\n')
}

declare module '@deepseek-ai/cordis' { interface Context { cuteafdHosts: Hosts } }

export class Hosts extends Service {
  static Config: schema<Config> = schema.object({ home: schema.string(), helperRoot: schema.string().required() })
  private readonly records = new Map<string, HostRecord>()
  private readonly pending = new Map<string, { spec: HostSpec; key: string; fingerprint: string; expires: number }>()
  private readonly home: string
  private readonly directory: string
  private readonly configFile: string
  private tail: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, private readonly config: Config, private readonly runner: Runner = run) {
    super(ctx, 'cuteafdHosts')
    this.home = resolve(config.home ?? homedir())
    this.directory = join(this.home, '.ssh')
    this.configFile = join(this.directory, 'ssh_config')
  }

  async [Service.init](): Promise<void> {
    await mkdir(join(this.directory, 'keys'), { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    let text: string
    try { text = await readFile(join(this.directory, 'hosts.json'), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const saved = z.array(hostSchema.extend({ knownHosts: z.string(), helper: z.string().optional(), helperHash: z.string().regex(/^[0-9a-f]{64}$/u).optional() })).parse(JSON.parse(text))
    for (const record of saved) {
      hostKeyFingerprint(record.knownHosts)
      if (record.knownHosts.split(/\s+/u)[0] !== knownHostName(record) || this.records.has(record.alias)) throw new Error('invalid persisted host identity')
      if ((record.helper === undefined) !== (record.helperHash === undefined) || (record.helper !== undefined && (!record.helper.startsWith('/') || /[\r\n\0]/u.test(record.helper)))) throw new Error('invalid persisted helper identity')
      this.records.set(record.alias, record)
    }
    await this.save()
  }

  list(): HostView[] { return [...this.records.values()].map(({ alias, hostname, user, port }) => ({ alias, hostname, user, port, confirmed: true })) }

  async scan(input: HostSpec): Promise<{ confirmation: string; fingerprint: string }> {
    const spec = hostSchema.parse(input)
    for (const [id, pending] of this.pending) if (pending.expires <= Date.now()) this.pending.delete(id)
    if (this.pending.size >= 32) throw new Error('too many pending host confirmations')
    if (this.records.has(spec.alias)) throw new Error('host alias already registered; remove it before changing identity')
    const output = await this.runner('ssh-keyscan', ['-T', '10', '-t', 'ed25519', '-p', String(spec.port), spec.hostname])
    const keys = output.split('\n').filter(line => line.trim() !== '' && !line.startsWith('#'))
    if (keys.length !== 1) throw new Error('host must advertise one Ed25519 key')
    const fingerprint = hostKeyFingerprint(keys[0]!)
    const fields = keys[0]!.trim().split(/\s+/u)
    const key = `${knownHostName(spec)} ${fields[1]} ${fields[2]}`
    const confirmation = randomUUID()
    this.pending.set(confirmation, { spec, key, fingerprint, expires: Date.now() + 300_000 })
    return { confirmation, fingerprint }
  }

  async confirm(confirmation: string, fingerprint: string, privateKey?: string): Promise<{ host: HostView; publicKey: string }> {
    const pending = this.pending.get(confirmation)
    this.pending.delete(confirmation)
    if (pending === undefined || pending.expires <= Date.now() || pending.fingerprint !== fingerprint) throw new Error('host fingerprint confirmation expired or mismatched')
    return await this.enqueue(async () => {
      if (this.records.has(pending.spec.alias)) throw new Error('host alias already registered')
      const keyPath = join(this.directory, 'keys', pending.spec.alias)
      if (privateKey !== undefined && (privateKey.length > 65_536 || !privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----'))) throw new Error('expected an unencrypted OpenSSH private key')
      const staging = `${keyPath}.${randomUUID()}`
      try {
        if (privateKey === undefined) await this.runner('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', staging])
        else await writeFile(staging, privateKey, { mode: 0o600, flag: 'wx' })
        await chmod(staging, 0o600)
        let publicKey: string
        try { publicKey = (await this.runner('ssh-keygen', ['-y', '-P', '', '-f', staging])).trim() } catch { throw new Error('expected a valid unencrypted OpenSSH private key') }
        if (!/^ssh-ed25519 [a-zA-Z0-9+/]+={0,2}$/u.test(publicKey)) throw new Error('expected an Ed25519 identity key')
        // Exclusive publication preserves any orphan/existing key instead of replacing it.
        await link(staging, keyPath)
        const record = { ...pending.spec, knownHosts: pending.key }
        this.records.set(record.alias, record)
        try { await this.save() } catch (error) { this.records.delete(record.alias); await rm(keyPath, { force: true }); throw error }
        return { host: { ...pending.spec, confirmed: true }, publicKey }
      } finally {
        await rm(staging, { force: true })
        await rm(`${staging}.pub`, { force: true })
      }
    })
  }

  async probe(alias: string): Promise<{ platform: string; machine: string; libc: string }> {
    this.record(alias)
    const result = await this.ssh(alias, 'command -v bash >/dev/null && bash -lc \'uname -sm; (getconf GNU_LIBC_VERSION 2>/dev/null || ldd --version 2>&1 | head -n 1)\'')
    const lines = result.trim().split('\n')
    const match = /^(Linux|Darwin) (x86_64|aarch64|arm64)$/u.exec(lines[0] ?? '')
    if (match === null) throw new Error('host requires bash and a qualified Linux/macOS x64/arm64 helper')
    return { platform: match[1]!, machine: match[2]!, libc: lines.slice(1).join('\n') }
  }

  async configuration(alias: string): Promise<SshConfig> {
    return await this.enqueue(async () => {
      const record = this.record(alias)
      if (record.helper === undefined) {
        const probe = await this.probe(alias)
        const target = `${probe.platform === 'Linux' ? 'linux' : 'macos'}-${probe.machine === 'x86_64' ? 'x64' : 'arm64'}`
        const archive = join(resolve(this.config.helperRoot), target, 'helper.tar.gz')
        const executable = join(resolve(this.config.helperRoot), target, 'dsh-ssh-helper')
        const helperHash = digest(await readFile(executable))
        const remoteHome = (await this.ssh(alias, 'printf "%s" "$HOME"')).trim()
        if (!remoteHome.startsWith('/') || /[\r\n\0]/u.test(remoteHome)) throw new Error('invalid remote home')
        const install = `${remoteHome}/.cache/cuteafd/dsh-helper/${helperHash}`
        const staging = `${install}.${randomUUID()}`
        const payload = await readFile(archive)
        // Stream through the authenticated connection; never interpolate an scp destination.
        await this.ssh(alias, `umask 077; mkdir -p ${quote(staging)} && cat > ${quote(`${staging}/helper.tar.gz`)}`, payload)
        const stagedExecutable = `${staging}/dsh-ssh-helper/dsh-ssh-helper`
        try {
          const observed = await this.ssh(alias, `tar -xzf ${quote(`${staging}/helper.tar.gz`)} -C ${quote(staging)} && rm ${quote(`${staging}/helper.tar.gz`)} && (sha256sum ${quote(stagedExecutable)} 2>/dev/null || shasum -a 256 ${quote(stagedExecutable)})`)
          if (observed.trim().split(/\s+/u)[0] !== helperHash) throw new Error('installed helper digest differs from bundled executable')
          await this.ssh(alias, `if test -d ${quote(install)}; then rm -rf ${quote(staging)}; else mv ${quote(staging)} ${quote(install)}; fi`)
        } catch (error) {
          await this.ssh(alias, `rm -rf ${quote(staging)}`).catch(() => {})
          throw error
        }
        record.helper = `${install}/dsh-ssh-helper/dsh-ssh-helper`
        record.helperHash = helperHash
        await this.save()
      }
      return { host: alias, configFile: this.configFile, launch: { kind: 'executable' }, helper: record.helper, helperHash: record.helperHash!, workspace: '/' }
    })
  }

  async canonical(host: string, path: string): Promise<string> {
    this.record(host)
    if (!path.startsWith('/') || /[\r\n\0]/u.test(path)) throw new Error('remote directory requires an absolute path')
    const result = (await this.ssh(host, `bash -c ${quote(`test -d ${quote(path)} && cd -- ${quote(path)} && pwd -P`)}`)).trim()
    if (!result.startsWith('/') || /[\r\n\0]/u.test(result)) throw new Error('invalid remote canonical directory')
    return result
  }

  async status(host: string, path: string): Promise<'ok' | 'missing-dir'> {
    this.record(host)
    if (!path.startsWith('/') || /[\r\n\0]/u.test(path)) throw new Error('remote directory requires an absolute path')
    const result = (await this.ssh(host, `if test -d ${quote(path)}; then printf ok; else printf missing-dir; fi`)).trim()
    if (result !== 'ok' && result !== 'missing-dir') throw new Error('invalid remote directory status')
    return result
  }

  private record(alias: string): HostRecord {
    aliasSchema.parse(alias)
    const record = this.records.get(alias)
    if (record === undefined) throw new Error('SSH host is not registered or fingerprint not confirmed')
    return record
  }
  private ssh(alias: string, command: string, input?: string | Uint8Array): Promise<string> { return this.runner('ssh', ['-F', this.configFile, '-T', alias, `exec "$SHELL" -l -c ${quote(command)}`], input) }
  private async save(): Promise<void> {
    const records = [...this.records.values()]
    // hosts.json is the durable commit point; generated files are repaired on restart.
    for (const [name, text] of [['known_hosts', records.map(record => record.knownHosts).join('\n') + '\n'], ['ssh_config', sshConfig(records, this.home)], ['hosts.json', JSON.stringify(records)]]) {
      const temporary = join(this.directory, `${name}.${randomUUID()}`)
      try {
        await writeFile(temporary, text!, { mode: 0o600, flag: 'wx' })
        await rename(temporary, join(this.directory, name!))
      } finally { await rm(temporary, { force: true }) }
    }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }
}

export class HostsController extends TypertRemoteService {
  static inject = ['cuteafdHosts']
  constructor(ctx: Context) { super(ctx, 'cuteafdHostsController', { namespace: 'cuteafdHosts' }) }
  @Remote('list')
  list(): HostView[] { return this.ctx.cuteafdHosts.list() }
  @Remote('scan')
  scan(spec: HostSpec): Promise<{ confirmation: string; fingerprint: string }> { return this.ctx.cuteafdHosts.scan(spec) }
  @Remote('confirm')
  confirm(confirmation: string, fingerprint: string, privateKey?: string): Promise<{ host: HostView; publicKey: string }> { return this.ctx.cuteafdHosts.confirm(confirmation, fingerprint, privateKey) }
  @Remote('probe')
  probe(alias: string): Promise<{ platform: string; machine: string; libc: string }> { return this.ctx.cuteafdHosts.probe(alias) }
}

export const name = 'cuteafd-hosts'
export const inject = ['executionWorlds', 'workspaceRegistry']
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(Hosts, config)
  await ctx.plugin(HostsController)
  const hosts = ctx.get('cuteafdHosts')!
  ctx.executionWorlds.configure(sshWorldFactory(ctx, alias => hosts.configuration(alias)))
  ctx.workspaceRegistry.configureRemote(hosts)
}
