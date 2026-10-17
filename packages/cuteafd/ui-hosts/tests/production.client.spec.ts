// @vitest-environment jsdom
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { TestClient, bundleRoster, remoteDefaultResponses } from '../../../test-support/client-runtime/src/assembly/index.ts'

it('boots every production browser plugin with guarded Remote capabilities and disposes them', async () => {
  const roster = bundleRoster(
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@cuteafd/dsh-remote-app'],
    resolve(import.meta.dirname, '../../remote-app/package.json'),
    { get: (name: string) => name === 'profileContext' ? { name: 'cuteafd' } : undefined },
  )
  // ui-hosts mounts its generated namespace itself; pre-seeding a proxy would conflict.
  const mock = RemoteMock.create().load(remoteDefaultResponses)
    // The document preview's nested injection is absent from the carrier's top-level roster metadata.
    .unary('officeToPdf/render', () => { throw new Error('unexpected office rendering in lifecycle gate') })
  const client = await TestClient.start({ roster }, mock, { mount: true })
  try {
    expect(roster.rows.some(row => row.name === '@cuteafd/dsh-ui-hosts')).toBe(true)
    expect(client.ctx.get('remote.cuteafdHosts')).toBeDefined()
    for (const runtime of client.ctx.registry.values()) for (const fiber of runtime.fibers) {
      expect(fiber.state, `${runtime.name}: inactive plugin`).toBe(FiberState.ACTIVE)
      for (const dependency of Object.keys(fiber.inject)) expect(fiber.ctx.get(dependency), `${runtime.name}: ${dependency}`).toBeDefined()
    }
    expect(client.container?.childElementCount).toBeGreaterThan(0)
  } finally { await client.dispose() }
  expect(client.ctx.get('remote.cuteafdHosts')).toBeUndefined()
}, 90_000)
