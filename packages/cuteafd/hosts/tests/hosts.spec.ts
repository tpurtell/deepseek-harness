import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Hosts, hostKeyFingerprint, type Runner } from '../src/index.ts'

const spec = { alias: 'rhea', hostname: '10.55.0.5', user: 'tj', port: 22 }
const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)])
const publicKey = `ssh-ed25519 ${blob.toString('base64')}`
const key = `10.55.0.5 ${publicKey}`

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-hosts-'))
  const ctx = new Context()
  const runner: Runner = vi.fn(async (command, args) => {
    if (command === 'ssh-keyscan') return `${key}\n`
    if (command === 'ssh-keygen' && args.includes('-f') && !args.includes('-y')) {
      await writeFile(String(args[args.indexOf('-f') + 1]), 'generated dedicated private key', { mode: 0o600 })
    }
    if (command === 'ssh-keygen' && args.includes('-y')) return publicKey
    if (command === 'ssh' && args.at(-1)?.includes('printf')) return '/home/tj'
    if (command === 'ssh' && args.at(-1)?.includes('sha256sum')) return `${createHash('sha256').update('helper').digest('hex')} file\n`
    if (command === 'ssh') return 'Linux aarch64\nglibc 2.39\n'
    return ''
  })
  class FixtureHosts extends Hosts {
    constructor(context: Context, config: { home: string; helperRoot: string }) { super(context, config, runner) }
  }
  await ctx.plugin(FixtureHosts, { home, helperRoot: join(home, 'helpers') })
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  return { home, ctx, runner, hosts: ctx.get('cuteafdHosts')! }
}

it('requires explicit fingerprint confirmation and persists only dedicated config/key paths', async () => {
  const { hosts, home } = await fixture()
  const scanned = await hosts.scan(spec)
  expect(hosts.list()).toEqual([])
  expect(scanned.fingerprint).toBe(`SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}`)
  const result = await hosts.confirm(scanned.confirmation, scanned.fingerprint)
  expect(result.publicKey).toBe(publicKey)
  expect(hosts.list()).toEqual([{ ...spec, confirmed: true }])
  const config = await readFile(join(home, '.ssh/ssh_config'), 'utf8')
  for (const option of ['IdentitiesOnly yes', 'BatchMode yes', 'StrictHostKeyChecking yes', 'ForwardAgent no']) expect(config).toContain(option)
  expect(config).toContain(join(home, '.ssh/keys/rhea'))
  expect((await stat(join(home, '.ssh/keys/rhea'))).mode & 0o777).toBe(0o600)
  await expect(readFile(join(home, '.ssh/config'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await hosts.probe('rhea')).toEqual({ platform: 'Linux', machine: 'aarch64', libc: 'glibc 2.39' })
})

it('rejects unconfirmed hosts, mismatched fingerprints and SSH option injection', async () => {
  const { hosts, runner } = await fixture()
  await expect(hosts.configuration('rhea')).rejects.toThrow('not registered')
  await expect(hosts.scan({ ...spec, hostname: '-oProxyCommand=x' })).rejects.toThrow()
  const scanned = await hosts.scan(spec)
  await expect(hosts.confirm(scanned.confirmation, 'SHA256:wrong')).rejects.toThrow('mismatched')
  expect(runner).toHaveBeenCalledTimes(1)
  expect(hosts.list()).toEqual([])
  expect(() => hostKeyFingerprint('host ssh-rsa bad')).toThrow('unsupported')
  expect(() => hostKeyFingerprint('host ssh-ed25519 YWJj')).toThrow('unsupported')
  expect(() => hostKeyFingerprint(`${key}\n${key}`)).toThrow('unsupported')
})

it('cleans a rejected pasted private key without registering a host', async () => {
  const { hosts, home, runner } = await fixture()
  vi.mocked(runner).mockImplementation(async command => command === 'ssh-keyscan' ? `${key}\n` : Promise.reject(new Error('private material must not escape')))
  const scanned = await hosts.scan(spec)
  await expect(hosts.confirm(scanned.confirmation, scanned.fingerprint, '-----BEGIN OPENSSH PRIVATE KEY-----\ninvalid')).rejects.toThrow('valid unencrypted')
  expect(hosts.list()).toEqual([])
  expect(await readdir(join(home, '.ssh/keys'))).toEqual([])
})

it('never overwrites an existing dedicated key', async () => {
  const { hosts, home } = await fixture()
  const path = join(home, '.ssh/keys/rhea')
  await writeFile(path, 'existing key', { mode: 0o600 })
  const scanned = await hosts.scan(spec)
  await expect(hosts.confirm(scanned.confirmation, scanned.fingerprint)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(path, 'utf8')).toBe('existing key')
  expect(await readdir(join(home, '.ssh/keys'))).toEqual(['rhea'])
  expect(hosts.list()).toEqual([])
})

it('expires fingerprint confirmations and refuses reuse', async () => {
  const { hosts } = await fixture()
  const scanned = await hosts.scan(spec)
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 300_001)
  onTestFinished(() => clock.mockRestore())
  await expect(hosts.confirm(scanned.confirmation, scanned.fingerprint)).rejects.toThrow('expired')
  await expect(hosts.confirm(scanned.confirmation, scanned.fingerprint)).rejects.toThrow('expired')
})

it('streams a helper over strict SSH, verifies its digest, and reuses the installed identity', async () => {
  const { hosts, home, runner } = await fixture()
  const directory = join(home, 'helpers/linux-arm64')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'dsh-ssh-helper'), 'helper')
  await writeFile(join(directory, 'helper.tar.gz'), 'archive')
  const scanned = await hosts.scan(spec)
  await hosts.confirm(scanned.confirmation, scanned.fingerprint)
  const first = await hosts.configuration(spec.alias)
  const calls = vi.mocked(runner).mock.calls.length
  expect(await hosts.configuration(spec.alias)).toEqual(first)
  expect(vi.mocked(runner).mock.calls.length).toBe(calls)
  expect(first.helperHash).toBe(createHash('sha256').update('helper').digest('hex'))
  expect(vi.mocked(runner).mock.calls.some(([command, , input]) => command === 'ssh' && Buffer.isBuffer(input))).toBe(true)
  expect(vi.mocked(runner).mock.calls.some(([command]) => command === 'scp')).toBe(false)
})

it('canonicalizes and checks directories only over a confirmed host connection', async () => {
  const { hosts, runner } = await fixture()
  const scanned = await hosts.scan(spec)
  await hosts.confirm(scanned.confirmation, scanned.fingerprint)
  vi.mocked(runner).mockResolvedValue('/remote/project\n')
  expect(await hosts.canonical('rhea', '/remote/link')).toBe('/remote/project')
  vi.mocked(runner).mockResolvedValue('ok')
  expect(await hosts.status('rhea', '/remote/project')).toBe('ok')
  vi.mocked(runner).mockResolvedValue('missing-dir')
  expect(await hosts.status('rhea', '/remote/project')).toBe('missing-dir')
  const calls = vi.mocked(runner).mock.calls.length
  await expect(hosts.canonical('rhea', 'relative')).rejects.toThrow('absolute')
  await expect(hosts.status('unknown', '/remote')).rejects.toThrow('not registered')
  expect(vi.mocked(runner).mock.calls.length).toBe(calls)
})

it('reloads confirmed identities with private permissions and no key material in API views', async () => {
  const { hosts, home } = await fixture()
  const scanned = await hosts.scan(spec)
  await hosts.confirm(scanned.confirmation, scanned.fingerprint)
  const second = new Context()
  onTestFinished(() => second.fiber.dispose())
  await second.plugin(Hosts, { home, helperRoot: join(home, 'helpers') })
  expect(second.get('cuteafdHosts')!.list()).toEqual([{ ...spec, confirmed: true }])
  for (const name of ['hosts.json', 'known_hosts', 'ssh_config']) expect((await stat(join(home, '.ssh', name))).mode & 0o777).toBe(0o600)
})
