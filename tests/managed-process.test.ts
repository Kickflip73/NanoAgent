import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { runManagedCommand } from '../src/core/managed-process.js';

test('managed commands report real exit results and reject before spawn when already aborted', async () => {
  const result = await runManagedCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 5_000 });
  assert.equal(result.stdout, 'ok');
  await assert.rejects(runManagedCommand(process.execPath, ['-e', 'process.stderr.write("bad input"); process.exit(2)'],
    { timeoutMs: 5_000 }), /failed \(2\): bad input/);
  assert.throws(() => runManagedCommand('/must-not-spawn', [],
    { timeoutMs: 5_000, signal: AbortSignal.abort(new Error('cancelled before start')) }), /cancelled before start/);
});

for (const outcome of ['abort', 'parent-exit', 'timeout'] as const) {
  test(`managed command cleans its owned descendant on ${outcome}`, { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
    const server = createServer();
    const connected = once(server, 'connection');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const controller = new AbortController();
    let socket: Socket | undefined;
    let running: Promise<unknown> | undefined;
    try {
      // The descendant announces readiness over a real socket. Closing this socket
      // is observed only after the owned process group has actually been stopped.
      const descendant = `const net = require('node:net'); const s = net.connect(${address.port}, '127.0.0.1', () => s.write('ready')); setInterval(() => {}, 1000);`;
      const parent = `const { spawn } = require('node:child_process');
        spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' });
        setInterval(() => {}, 1000);`;
      // For the normal-exit case, a second control socket makes the parent exit
      // after its child is ready, without depending on a guessed startup delay.
      const source = outcome === 'parent-exit' ? `${parent}
        const net = require('node:net'); const control = net.connect(${address.port}, '127.0.0.1');
        control.on('data', () => process.exit(0)); control.on('connect', () => control.write('parent'));` : parent;
      let control: Socket | undefined;
      const descendantReady = new Promise<Socket>((resolve) => {
        server.on('connection', (client) => client.once('data', (data) => {
          if (data.toString() === 'parent') control = client;
          else resolve(client);
          if (control && socket) control.write('exit');
        }));
      });
      running = runManagedCommand(process.execPath, ['-e', source], {
        timeoutMs: outcome === 'timeout' ? 1_500 : 5_000, signal: controller.signal,
      });
      const settled = outcome === 'parent-exit' ? running : assert.rejects(running, outcome === 'abort' ? /test cancellation/ : /timed out/);
      await connected;
      socket = await descendantReady;
      const closed = once(socket, 'close');
      if (outcome === 'abort') controller.abort(new Error('test cancellation'));
      if (outcome === 'parent-exit') control?.write('exit');
      await settled;
      await closed;
      assert.equal(socket.destroyed, true);
    } finally {
      controller.abort(new Error('test cleanup'));
      await running?.catch(() => undefined);
      socket?.destroy();
      server.close();
    }
  });
}
