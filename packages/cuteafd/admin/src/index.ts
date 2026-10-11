#!/usr/bin/env node
/** Deployment-owned credential updates through the harness's own atomic writer. */
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'

export async function setCredential(name: string, value: string, dshHome?: string): Promise<void> {
  const ref = credentialRef(name)
  if (value.length === 0 || /[\r\n\0]/u.test(value)) throw new Error('credential must be one nonempty line')
  const ctx = new Context()
  try {
    await ctx.plugin(LocalCredentialProvider, { watch: false, ...(dshHome === undefined ? {} : { dshHome }) })
    const credentials = ctx.get('credentials')
    if (credentials === undefined) throw new Error('credential provider unavailable')
    await credentials.set(ref, value)
  } finally { await ctx.fiber.dispose() }
}

export async function main(args: readonly string[], input: AsyncIterable<Uint8Array | string>): Promise<void> {
  if (args.length !== 2 || args[0] !== 'set-credential') throw new Error('usage: dsh-cuteafd set-credential NAME < secret')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 65_536) throw new Error('credential input exceeds 64 KiB')
    chunks.push(bytes)
  }
  const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/u, '')
  await setCredential(args[1]!, value)
}

if (import.meta.main) {
  main(process.argv.slice(2), process.stdin).catch(() => {
    // Never print errors that may quote a malformed document or credential input.
    process.stderr.write('dsh-cuteafd: credential update failed\n')
    process.exitCode = 1
  })
}
