import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const source = resolve(import.meta.dirname, '../../../..');
const require = createRequire(join(source, 'apps/cli/package.json'));
const mod = async name => import(require.resolve(name));
const home = await mkdtemp(join(tmpdir(), 'dsh-production-lifecycle-'));
const children = [];
const peers = [];
const originalSpawn = childProcess.spawn;
let ctx;
try {
  for (const [name, folder] of Object.entries({ HOME: 'home', DSH_HOME: 'dsh', DSH_AGENTS_HOME: 'agents' })) {
    process.env[name] = join(home, folder);
    await mkdir(process.env[name], { mode: 0o700 });
  }
  process.env.DSH_REMOTE_ONLY = '1';
  process.env.DSH_TELEMETRY_DISABLED = '1';
  const { SshRpcPeer } = await import(pathToFileURL(join(source, 'packages/ssh/ssh/lib/protocol.js')));
  childProcess.spawn = (program, args, options) => {
    if (program !== 'ssh') return originalSpawn(program, args, options);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stopped = false;
    child.kill = () => {
      if (!child.stopped) {
        child.stopped = true;
        queueMicrotask(() => child.emit('close', 0, null));
      }
      return true;
    };
    children.push(child);
    peers.push(new SshRpcPeer(child.stdin, child.stdout, 64 * 1024 * 1024, 128, async (method, params) => {
      if (method === 'hello') return {
        protocol: 2, hash: 'a'.repeat(64), platform: 'linux', nodeVersion: process.version,
        kind: 'executable', executable: '/stub/helper', root: '/stub', workspace: params.workspace,
      };
      if (method === 'heartbeat' || method === 'close') return null;
      if (method === 'fs.resolve') return { targetKey: params.path, displayPath: params.path };
      if (method === 'fs.stat') return { type: 'directory', version: 'stub-v1' };
      throw new Error(`unexpected transport request ${method}`);
    }));
    return child;
  };
  syncBuiltinESMExports();
  const { runProfile } = await import(pathToFileURL(join(source, 'apps/cli/lib/profile-boot.js')));
  const { createLaunchEnvironmentSnapshot } = await mod('@deepseek-ai/dsh-launch-environment');
  const overlay = join(home, 'test.patch.yml');
  await writeFile(overlay, `- id: connection\n  config:\n    launchTokenFile: ${JSON.stringify(join(home, 'launch-token'))}\n`);
  const { ctx: app } = await runProfile({
    environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }]),
    profile: 'cuteafd', patchFiles: [overlay], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
  });
  ctx = app;
  // FiberState is a const enum and therefore absent from built JavaScript.
  const ACTIVE = 2;
  const FAILED = 3;
  const seen = new Set();
  function audit() {
    for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) {
      assert.notEqual(fiber.state, FAILED, `${runtime.name}: failed plugin`);
      if (fiber.state !== ACTIVE) {
        // The stock local picker controller waits deliberately: remote-only removes its provider.
        assert.equal(runtime.name, 'DirectoryPickerController', `${runtime.name}: inactive plugin`);
        assert.equal(fiber.state, 0);
        assert.deepEqual(Object.keys(fiber.inject), ['directoryPicker']);
        continue;
      }
      seen.add(runtime.name);
      for (const name of Object.keys(fiber.inject)) assert(fiber.ctx[name] !== undefined, `${runtime.name}: ${name}`);
    }
  }
  audit();
  assert(seen.has('cuteafd-execution-worlds'));
  assert(ctx.get('cuteafdHosts'));
  assert(ctx.get('webServer'));
  assert(ctx.get('pluginManager'));
  const hosts = ctx.get('cuteafdHosts');
  hosts.configuration = async alias => ({ host: alias, helper: '/stub/helper', helperHash: 'a'.repeat(64), launch: { kind: 'executable' }, workspace: '/stub/work' });
  // Exercise the same caller-shadow path as the host picker, without host key I/O.
  const { sshWorldFactory } = await mod('@cuteafd/dsh-execution-worlds');
  const caller = ctx.plugin({ inject: ['cuteafdHosts'], apply(owner) {
    owner.provide('lifecycleCaller', { async construct() {
      return sshWorldFactory(owner.extend({ [Symbol.for('cordis.shadow')]: owner }), hosts.configuration)(
        { kind: 'cuteafd-ssh', host: 'stub', path: '/stub/work' },
        { id: 'picker', cwd: '/stub/work' });
    } });
  } });
  await caller;
  const picker = await ctx.get('lifecycleCaller').construct();
  for (const name of ['fs', 'subprocess', 'sandbox', 'shell', 'ptcRuntime']) assert(picker[name]);
  audit();
  await picker.dispose();
  const controller = ctx.get('sessionController');
  for (const preset of ['standard', 'minimal', 'ptc']) {
    const sessionId = `lifecycle-${preset}`;
    await controller.create({ sessionId, host: 'stub', cwd: '/stub/work', agentPreset: preset });
    const resolved = await controller.resolveAgent(sessionId);
    assert(!('error' in resolved));
    await ctx.get('executionWorlds').within(resolved.agent, () => {
      const world = ctx.get('executionWorlds').current();
      assert.equal(world.host, 'stub');
      assert(world.fs && world.subprocess && world.sandbox && world.shell && world.ptcRuntime);
      audit();
    });
  }
  assert(children.length >= 4, 'all preset and picker connections constructed');
  await ctx.fiber.dispose();
  assert(children.every(child => child.stopped), 'every stub transport disposed');
  assert.equal(ctx.get('executionWorlds'), undefined);
  console.log(`production lifecycle PASS (${seen.size} plugin types, ${children.length} SSH worlds)`);
} finally {
  await ctx?.fiber.dispose();
  peers.forEach(peer => peer.close());
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  await rm(home, { recursive: true, force: true });
}
