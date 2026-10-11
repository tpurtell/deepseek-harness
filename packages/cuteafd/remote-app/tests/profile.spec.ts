import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../../..')
function patches(path: string): PatchOptions[] {
  return load(readFileSync(resolve(root, path), 'utf8'), { schema: entryListSchema }) as PatchOptions[]
}

it('removes local execution and creator/model-install rows but retains operator installation and permissions', () => {
  const layers = [
    'packages/bundle/base/cordis.patch.yml', 'packages/bundle/web-app/cordis.patch.yml',
    ...['standard', 'ptc', 'minimal', 'cordis'].map(name => `packages/bundle/web-app/presets/${name}.patch.yml`),
    'packages/cuteafd/remote-app/cordis.patch.yml',
  ].flatMap(patches)
  const rows = applyEntryPatches([], layers, () => {})
  const all: EntryOptions[] = []
  function visit(entries: EntryOptions[]) {
    for (const row of entries) {
      all.push(row)
      if (row.group && Array.isArray(row.config)) visit(row.config)
      if (row.name === '@deepseek-ai/dsh-agent-preset') visit(row.config.plugins)
    }
  }
  visit(rows)
  const names = new Set(all.map(row => row.name))
  for (const name of ['subprocess-local', 'sandbox-local', 'fs-sandbox', 'bash-sandbox', 'pwsh-sandbox', 'ptc-runtime-node', 'workspace-changes', 'skill-filesystem']) {
    expect(names.has(`@deepseek-ai/dsh-${name}`), name).toBe(false)
  }
  expect(names.has('@deepseek-ai/dsh-plugin-manager/tools')).toBe(false)
  expect(all.some(row => row.id === 'preset-cordis')).toBe(false)
  expect(names.has('@deepseek-ai/dsh-plugin-manager')).toBe(true)
  expect(names.has('@deepseek-ai/dsh-client-ui-plugin-manager')).toBe(true)
  expect(names.has('@cuteafd/dsh-execution-worlds')).toBe(true)
  const permission = all.find(row => row.id === 'permission')
  expect(permission?.config.presets['workspace-write']).toEqual({ sandbox: 'workspace-write', approval: 'ask' })
})
