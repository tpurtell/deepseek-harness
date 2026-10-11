import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const source = resolve(import.meta.dirname, '../../../..');
const require = createRequire(join(source, 'apps/cli/package.json'));
const mod = async name => import(require.resolve(name));
const home = await mkdtemp(join(tmpdir(), 'dsh-production-lifecycle-'));
const children = [];
const forwards = new Map();
const sockets = new Set();
const originalSpawn = childProcess.spawn;
const originalExecFile = childProcess.execFile;
const exec = promisify(originalExecFile);
let ctx;
try {
  for (const [name, folder] of Object.entries({ HOME: 'home', DSH_HOME: 'dsh', DSH_AGENTS_HOME: 'agents' })) {
    process.env[name] = join(home, folder);
    await mkdir(process.env[name], { mode: 0o700 });
  }
  process.env.DSH_REMOTE_ONLY = '1';
  process.env.DSH_TELEMETRY_DISABLED = '1';
  const workspace = join(home, 'remote-work');
  await mkdir(join(workspace, 'nested'), { recursive: true });
  const helperEntry = join(source, 'packages/ssh/ssh/lib/helper.js');
  const bootstrap = join(source, 'packages/ptc-runtime/ptc-runtime-node/lib/process.js');
  const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
  const helperHash = await digest(helperEntry);
  const bootstrapHash = await digest(bootstrap);
  // Only SSH transport is substituted. Real helper RPC, providers, streams and routing remain intact.
  childProcess.spawn = (program, args, options) => {
    if (program !== 'ssh') return originalSpawn(program, args, options);
    const child = originalSpawn(process.execPath, [helperEntry], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: home } });
    child.stopped = false;
    const kill = child.kill.bind(child);
    child.kill = signal => { child.stopped = true; return kill(signal); };
    child.once('close', () => { child.stopped = true; });
    children.push(child);
    return child;
  };
  childProcess.execFile = (program, args, options, callback) => {
    if (program !== 'ssh') return originalExecFile(program, args, options, callback);
    const child = new EventEmitter();
    child.kill = () => true;
    const operation = (async () => {
      const action = args[args.indexOf('-O') + 1];
      const [local, remote] = args[args.indexOf('-L') + 1].split(':');
      if (action === 'cancel') {
        const server = forwards.get(local);
        forwards.delete(local);
        server?.close();
      } else {
        assert.equal(action, 'forward');
        const server = createServer({ allowHalfOpen: true }, socket => {
          const upstream = createConnection({ path: remote, allowHalfOpen: true });
          for (const peer of [socket, upstream]) {
            sockets.add(peer);
            peer.once('close', () => sockets.delete(peer));
            peer.on('error', () => { socket.destroy(); upstream.destroy(); });
          }
          socket.pipe(upstream).pipe(socket);
        });
        forwards.set(local, server);
        server.listen(local);
        await once(server, 'listening');
      }
    })();
    operation.then(() => callback(null, '', ''), error => callback(error, '', '')).finally(() => child.emit('close', 0, null));
    return child;
  };
  syncBuiltinESMExports();
  // Confirmed fixture identity; no existing key or SSH configuration is read or modified.
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]);
  await mkdir(join(process.env.HOME, '.ssh'), { recursive: true });
  await writeFile(join(process.env.HOME, '.ssh/hosts.json'), JSON.stringify([{ alias: 'stub', hostname: 'stub', user: 'test', port: 22, knownHosts: `stub ssh-ed25519 ${blob.toString('base64')}` }]));
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
        // The stock local picker waits deliberately: remote-only removes its provider.
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
  assert(ctx.get('webServer'));
  assert(ctx.get('pluginManager'));
  const hosts = ctx.get('cuteafdHosts');
  const rawHosts = Reflect.get(hosts, Symbol.for('cordis.original')) ?? hosts;
  rawHosts.configuration = async alias => ({ host: alias, helper: helperEntry, helperHash, launch: { kind: 'node-script', node: process.execPath, bootstrapPath: bootstrap, bootstrapHash }, workspace });
  rawHosts.runner = async (program, args) => {
    assert.equal(program, 'ssh');
    return (await exec('/bin/bash', ['-c', args.at(-1)], { env: { ...process.env, SHELL: '/bin/bash', HOME: workspace }, timeout: 10_000 })).stdout;
  };
  const listing = await hosts.listDirectory('stub', workspace);
  assert.equal(listing.path, workspace);
  assert(listing.entries.some(entry => entry.name === 'nested' && entry.path === join(workspace, 'nested')));
  const controller = ctx.get('sessionController');
  const capabilities = ['fs', 'subprocess', 'sandbox', 'shell', 'ptcRuntime', 'workingDirectory', 'fileReferences', 'jobs', 'jobController', 'cuteafdHosts', 'tools'];
  const { ToolCallId } = await mod('@deepseek-ai/dsh-llm');
  const { Service } = await mod('@deepseek-ai/cordis');
  class StockCapabilityCaller extends Service {
    static inject = capabilities;
    constructor(owner) { super(owner, 'lifecycleCapabilities'); owner.jobs.attachController('production-behavior-observer'); }
    execute(operation) { return operation(this.ctx); }
  }
  for (const preset of ['standard', 'minimal', 'ptc']) {
    const sessionId = `lifecycle-${preset}`;
    await controller.create({ sessionId, host: 'stub', cwd: workspace, agentPreset: preset });
    const resolved = await controller.resolveAgent(sessionId);
    assert(!('error' in resolved));
    const agent = resolved.agent;
    // A real plugin injection context, not root ctx or raw world services, exercises Cordis tracing.
    const caller = agent.ctx.plugin(StockCapabilityCaller);
    await caller;
    const stock = agent.ctx.get('lifecycleCapabilities');
    await ctx.get('executionWorlds').within(agent, async () => stock.execute(async stock => {
      const world = ctx.get('executionWorlds').current();
      assert.equal(world.host, 'stub');
      assert.equal(world.fs[Symbol.for('cordis.tracker')], undefined, 'session-owned provider must not be retraced');
      const picked = await stock.cuteafdHosts.listDirectory('stub', workspace);
      assert.equal(picked.path, workspace);
      assert(picked.entries.some(entry => entry.name === 'nested'));
      audit();
      const target = await stock.fs.resolve(join(workspace, `${preset}.txt`));
      const policy = { mode: 'danger-full-access', workspaceRoot: workspace };
      await stock.fs.writeText(target, `fixture-${preset}`, undefined, undefined, policy);
      assert.equal(await stock.fs.readText(target), `fixture-${preset}`);
      assert.equal((await stock.fs.stat(target)).type, 'file');
      assert((await stock.fs.listDir(await stock.fs.resolve(workspace))).some(entry => entry.name === `${preset}.txt`));
      let text = '';
      for await (const part of await stock.fs.streamText(target)) text += part;
      assert.equal(text, `fixture-${preset}`);
      const spec = stock.shell.resolve({ command: `printf shell-${preset}; printf diagnostic >&2`, workdir: workspace, sandboxPolicy: policy });
      const shell = await stock.shell.execute(spec);
      const result = await shell.result();
      assert.equal(result.stdout.text, `shell-${preset}`);
      assert.equal(result.stderr.text, 'diagnostic');
      assert.equal(shell.exitCode, 0);
      const sleeping = stock.subprocess.spawn({ argv: ['/bin/sh', '-c', 'printf stream-ready; exec /bin/sleep 60'], cwd: workspace, graceMs: 100, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4096 } } });
      try {
        let stream = '';
        for await (const bytes of sleeping.stdout) { stream += bytes.toString(); if (stream.includes('stream-ready')) break; }
        assert.equal(stream, 'stream-ready');
        sleeping.terminate();
        const outcome = await sleeping.done;
        assert(outcome.signal !== null || outcome.exitCode !== 0);
        assert.equal(await sleeping.waitForExit(), true);
      } finally { sleeping.terminate(); sleeping.stdout?.destroy(); }
      const confined = await stock.sandbox.confine(['/bin/sh', '-c', 'printf confined'], { mode: 'read-only', workspaceRoot: workspace });
      assert(['full', 'partial'].includes(confined.enforcement));
      assert.deepEqual(confined.argv.slice(-3), ['/bin/sh', '-c', 'printf confined']);
      const terminal = await stock.subprocess.spawnTerminal({ argv: ['/bin/sh'], cwd: workspace, env: {}, terminalType: 'xterm', cols: 80, rows: 24, graceMs: 100 });
      let terminalText = '';
      const terminalRead = (async () => { for await (const bytes of terminal.output) terminalText += Buffer.from(bytes).toString(); })();
      try {
        await terminal.resize(100, 35);
        const foreground = await terminal.inspectForeground();
        assert(foreground !== undefined);
        const activity = await terminal.inspectActivity();
        assert(activity !== undefined);
        await terminal.write("stty size; printf 'terminal-result\\n'; exit\n");
        assert.equal((await terminal.done).exitCode, 0);
        await terminalRead;
        assert(terminalText.includes('terminal-result'));
        assert(terminalText.includes('35 100'));
      } finally { await terminal.terminate(); await terminalRead; }
      const ptc = await stock.ptcRuntime.run(stock.ptcRuntime.resolve({ program: `return await (await import('node:fs/promises')).readFile(${JSON.stringify(join(workspace, `${preset}.txt`))},'utf8')`, bindings: [], cwd: workspace, sandboxPolicy: policy, timeoutMs: 10_000 }));
      assert.equal(ptc.error, undefined, JSON.stringify(ptc));
      assert.equal(ptc.value, `fixture-${preset}`);
      const names = stock.tools.schemas(agent).map(tool => tool.name);
      const call = (name, arguments_) => stock.tools.execute({ agent, name, arguments: arguments_, callId: ToolCallId(`behavior-${preset}-${name}`), signal: AbortSignal.timeout(10_000) });
      if (preset !== 'ptc' && names.includes('read')) {
        const read = await call('read', { file_path: `${preset}.txt` });
        assert(!read.isError && JSON.stringify(read).includes(`fixture-${preset}`), JSON.stringify(read));
      }
      if (preset !== 'ptc' && names.includes('bash')) {
        const bash = await call('bash', { command: 'printf stock-tool-shell', description: 'Exercise production shell policy' });
        assert(!bash.isError && JSON.stringify(bash).includes('stock-tool-shell'), JSON.stringify(bash));
      }
      if (names.includes('run_code')) {
        const code = await call('run_code', { code: 'return 6 * 7', description: 'Exercise production PTC policy' });
        assert(!code.isError && JSON.stringify(code).includes('42'), JSON.stringify(code));
      }
      const completion = await stock.fileReferences.list(agent, preset, AbortSignal.timeout(10_000));
      assert(completion.some(row => row.path === `${preset}.txt`));
      assert.equal(await stock.workingDirectory.set(agent, join(workspace, 'nested')), join(workspace, 'nested'));
      assert.equal(stock.workingDirectory.get(agent.session), join(workspace, 'nested'));
      assert(agent.session.snapshotEvents().some(event => event.type === 'working-directory/change' && event.data.cwd === join(workspace, 'nested')));
      assert.equal(await stock.workingDirectory.set(agent, workspace), workspace);
      {
        const proc = await stock.shell.execute(stock.shell.resolve({ command: `printf watcher-${preset}; exec sleep 60`, workdir: workspace, sandboxPolicy: policy }));
        const jobId = stock.jobs.start({ kind: 'bash', label: 'Remote process watcher', owner: agent.id,
          output: [{ channel: 'stdout', read: offset => proc.observed.stdout.readFrom(offset) }],
          run: () => ({ cancel: () => { proc.kill(); }, done: proc.done.then(() => ({ status: proc.status === 'killed' ? 'killed' : 'completed' })) }),
        });
        const frames = [];
        for await (const frame of stock.jobController.follow({ sessionId: agent.id, jobId }, AbortSignal.timeout(10_000))) {
          frames.push(frame);
          if (frame.type === 'output' && frame.chunks.some(chunk => chunk.text.includes(`watcher-${preset}`))) assert.equal(stock.jobController.kill({ sessionId: agent.id, jobId }).outcome, 'requested');
        }
        assert(frames.some(frame => frame.type === 'opened'));
        assert(frames.some(frame => frame.type === 'output' && frame.chunks.some(chunk => chunk.text.includes(`watcher-${preset}`))));
        assert(frames.some(frame => frame.type === 'status' && frame.job.status === 'killed'));
      }
    }));
    await caller.dispose();
  }
  assert(children.length >= 4, 'all preset and picker connections constructed');
  await ctx.fiber.dispose();
  assert(children.every(child => child.stopped), 'every stub transport disposed');
  assert.equal(ctx.get('executionWorlds'), undefined);
  console.log(`production lifecycle PASS (${seen.size} plugin types, ${children.length} SSH worlds; files/shell/streams/kill/PTC/watcher/picker/cwd/completion asserted)`);
} finally {
  await ctx?.fiber.dispose();
  for (const child of children) if (!child.stopped) child.kill('SIGKILL');
  for (const socket of sockets) socket.destroy();
  for (const server of forwards.values()) server.close();
  childProcess.spawn = originalSpawn;
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
  await rm(home, { recursive: true, force: true });
}
