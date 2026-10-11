// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

it('loads only the same-origin console palette and disposes stylesheet and both-mode overrides', async () => {
  const ctx = new Context()
  const removeTokens = vi.fn()
  const overrideTokens = vi.fn(() => removeTokens)
  ctx.provide('theme', { overrideTokens } as never)
  const fiber = ctx.plugin({ inject: ['theme'], apply })
  await fiber.await()
  expect(document.head.querySelector('link[href="/agent/theme.css"]')).not.toBeNull()
  expect(overrideTokens).toHaveBeenCalledWith('cuteafd-facet', expect.objectContaining({
    '--dsw-alias-bg-base': { light: 'var(--bg)', dark: 'var(--bg)' },
    '--dsw-alias-label-primary': { light: 'var(--ink)', dark: 'var(--ink)' },
    '--dsw-alias-border-l1': { light: 'var(--line)', dark: 'var(--line)' },
  }))
  await fiber.dispose()
  expect(document.head.querySelector('link[href="/agent/theme.css"]')).toBeNull()
  expect(removeTokens).toHaveBeenCalledTimes(1)
  await ctx.fiber.dispose()
})
