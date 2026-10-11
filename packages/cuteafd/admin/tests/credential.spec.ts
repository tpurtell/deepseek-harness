import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import { main, setCredential } from '../src/index.ts'

async function fixture(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'cuteafd-admin-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  return home
}

it('updates only the named ref, preserving signing keys, records and comments across restart', async () => {
  const home = await fixture()
  const filename = join(home, '.credentials.yaml')
  await writeFile(filename, '# operator configuration\nversion: 1\nrefs:\n  COOKIE_SECRET: signing-secret # keep\n  CUTEAFD_AGENT_API_KEY: old\nrecords:\n  provider/default:\n    kind: api-key\n    key: other-secret\n', { mode: 0o600 })
  await setCredential('CUTEAFD_AGENT_API_KEY', 'new', home)
  await setCredential('CUTEAFD_AGENT_API_KEY', 'rotated', home)
  const text = await readFile(filename, 'utf8')
  const parsed = parseCredentialsDocument(text, filename)
  expect(parsed.refs.get('CUTEAFD_AGENT_API_KEY')).toBe('rotated')
  expect(parsed.refs.get('COOKIE_SECRET')).toBe('signing-secret')
  expect(parsed.records.get('provider/default')).toEqual({ kind: 'api-key', key: 'other-secret' })
  expect(text).toContain('# operator configuration')
  expect(text).toContain('# keep')
  expect((await stat(filename)).mode & 0o777).toBe(0o600)
})

it('uses the provider migration for a flat store', async () => {
  const home = await fixture()
  const filename = join(home, '.credentials.yaml')
  await writeFile(filename, 'COOKIE_SECRET: signing-secret\n', { mode: 0o600 })
  await setCredential('CUTEAFD_AGENT_API_KEY', 'new', home)
  const parsed = parseCredentialsDocument(await readFile(filename, 'utf8'), filename)
  expect(parsed.refs.get('COOKIE_SECRET')).toBe('signing-secret')
  expect(parsed.refs.get('CUTEAFD_AGENT_API_KEY')).toBe('new')
})

it('rejects invalid names, multiline values and oversized stdin without printing secrets', async () => {
  const home = await fixture()
  await expect(setCredential('bad/name', 'secret', home)).rejects.toThrow()
  await expect(setCredential('CUTEAFD_AGENT_API_KEY', 'secret\nsecond', home)).rejects.toThrow('one nonempty line')
  async function* large() { yield Buffer.alloc(65_537) }
  await expect(main(['set-credential', 'CUTEAFD_AGENT_API_KEY'], large())).rejects.toThrow('64 KiB')
})
