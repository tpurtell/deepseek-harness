import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pnpmInvocation, restoreLegacyHoists } from './executable-packaging.ts'
import { materializeStagedLinks, deduplicateStagedWorkspacePackages } from './build-exe-for-python-sdk-staging.ts'
import { verifyRuntimeClosure } from './verify-runtime-closure.ts'

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({ options: { output: { type: 'string' } } })
if (values.output === undefined) throw new Error('--output is required')
const output = resolve(values.output)
if (output === root || root.startsWith(`${output}/`)) throw new Error('runtime output cannot contain source root')
const closure = await verifyRuntimeClosure(root, 'packages/cuteafd/runtime/package.json', false)
if (closure.failures.length > 0) throw new Error(closure.failures.join('\n'))
const run = (args: string[]): void => {
  const [command, argv] = pnpmInvocation(args)
  const child = spawnSync(command, argv, { cwd: root, stdio: 'inherit' })
  if (child.error !== undefined) throw child.error
  if (child.status !== 0) throw new Error(`runtime deploy failed: ${args.join(' ')}`)
}
await rm(output, { recursive: true, force: true })
try {
  run(['--filter', '@cuteafd/dsh-runtime', 'deploy', '--legacy', '--prod', '--config.allow-unused-patches=true', '--config.node-linker=hoisted', '--config.auto-install-peers=false', '--config.link-workspace-packages=true', '--config.hoist-workspace-packages=false', output])
} finally {
  run(['install', '--offline', '--frozen-lockfile', '--prod=false', '--ignore-scripts'])
}
await restoreLegacyHoists(output, join(root, 'packages/cuteafd/runtime/node_modules'))
await materializeStagedLinks(output)
await deduplicateStagedWorkspacePackages(output, root)
await mkdir(output, { recursive: true })
await copyFile(join(root, 'LICENSE'), join(output, 'LICENSE'))

// Legacy deployment re-resolves ranges; require the exact tested replay backend and patches.
const sourceRequire = createRequire(join(root, 'packages/llm/llm-pi-ai/package.json'))
const deployedRequire = createRequire(join(output, 'node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json'))
const sourcePi = resolve(sourceRequire.resolve('@earendil-works/pi-ai'), '../..')
const deployedPi = resolve(deployedRequire.resolve('@earendil-works/pi-ai'), '../..')
for (const file of ['package.json', 'dist/api/transform-messages.js', 'dist/api/openai-completions.js', 'dist/api/openai-responses-shared.js']) {
  if (!(await readFile(join(sourcePi, file))).equals(await readFile(join(deployedPi, file)))) {
    throw new Error(`runtime pi-ai differs from the tested dependency: ${file}`)
  }
}
