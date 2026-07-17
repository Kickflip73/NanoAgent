import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  controlTokenPathForSocket,
  ensureControlToken,
  mimiRpc,
  MimiIpcServer,
  readControlToken,
} from '../src/daemon/ipc.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('unix socket RPC supports requests and reports handler failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ipc-'));
  const socket = path.join(root, 'mimi.sock');
  const server = new MimiIpcServer(socket, (method, params) => {
    if (method === 'ping') return { pong: true };
    if (method === 'echo') return params;
    throw new Error('no such method');
  });
  await server.start();
  try {
    assert.deepEqual(await mimiRpc(socket, 'echo', { value: 42 }), { value: 42 });
    await assert.rejects(mimiRpc(socket, 'missing'), /no such method/);
  } finally {
    await server.close();
  }
});

test('control token creation is atomic, stable, owner-only, and optional for legacy daemons', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ipc-token-'));
  const socket = path.join(root, 'mimi.sock');
  assert.equal(await readControlToken(socket), undefined);
  await ensureControlToken(socket);
  const file = controlTokenPathForSocket(socket);
  const first = await readControlToken(socket);
  assert.match(first ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await ensureControlToken(socket);
  assert.equal(await readControlToken(socket), first);

  await chmod(file, 0o644);
  await assert.rejects(readControlToken(socket), /权限必须是 0600/);
  await assert.rejects(ensureControlToken(socket), /权限必须是 0600/);
  await chmod(file, 0o600);
  assert.equal(await readControlToken(socket), first);

  await writeFile(file, 'guessable\n', { mode: 0o600 });
  await assert.rejects(ensureControlToken(socket), /内容无效/);
});

test('IPC keeps the request frame small while allowing bounded management responses over 1MB', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ipc-response-'));
  const socket = path.join(root, 'mimi.sock');
  const value = '界'.repeat(400_000);
  const server = new MimiIpcServer(socket, () => ({ value }));
  await server.start();
  try {
    assert.deepEqual(await mimiRpc(socket, 'large-response'), { value });
  } finally {
    await server.close();
  }
});

test('a second IPC server cannot replace a live daemon socket', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ipc-live-'));
  const socket = path.join(root, 'mimi.sock');
  const first = new MimiIpcServer(socket, () => ({ ok: true }));
  const second = new MimiIpcServer(socket, () => ({ ok: true }));
  await first.start();
  try {
    await assert.rejects(second.start(), /MimiAgent 已在运行/);
    await second.close();
    assert.deepEqual(await mimiRpc(socket, 'ping'), { ok: true });
  } finally {
    await first.close();
  }
});

test('startup never unlinks a live socket when its lock and control token disagree', async (context) => {
  for (const lockState of ['missing', 'corrupt'] as const) {
    await context.test(lockState, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `mimi-ipc-auth-lock-${lockState}-`));
      const socket = path.join(root, 'mimi.sock');
      await ensureControlToken(socket);
      const firstToken = await readControlToken(socket);
      assert.ok(firstToken);
      const first = new MimiIpcServer(socket, (method, _params, _signal, auth) => {
        if (auth !== firstToken) throw new Error('first daemon rejected control auth');
        return { owner: 'first', method };
      });
      const second = new MimiIpcServer(socket, () => ({ owner: 'second' }));
      await first.start();
      try {
        const originalSocket = await lstat(socket, { bigint: true });
        if (lockState === 'missing') await rm(`${socket}.lock`, { force: true });
        else await writeFile(`${socket}.lock`, 'corrupt\n', { mode: 0o600 });
        await rm(controlTokenPathForSocket(socket), { force: true });
        await ensureControlToken(socket);
        assert.notEqual(await readControlToken(socket), firstToken);

        await assert.rejects(second.start(), /MimiAgent 已在运行/);
        const currentSocket = await lstat(socket, { bigint: true });
        assert.equal(currentSocket.dev, originalSocket.dev);
        assert.equal(currentSocket.ino, originalSocket.ino);
        assert.equal(currentSocket.ctimeNs, originalSocket.ctimeNs);

        await rm(controlTokenPathForSocket(socket), { force: true });
        await writeFile(controlTokenPathForSocket(socket), `${firstToken}\n`, { mode: 0o600 });
        assert.deepEqual(await mimiRpc(socket, 'ping'), { owner: 'first', method: 'ping' });
      } finally {
        await Promise.allSettled([first.close(), second.close()]);
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('concurrent IPC startup elects one owner and the loser cannot remove its socket', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ipc-race-'));
  const socket = path.join(root, 'mimi.sock');
  const first = new MimiIpcServer(socket, () => ({ owner: 'first' }));
  const second = new MimiIpcServer(socket, () => ({ owner: 'second' }));
  const starts = await Promise.allSettled([first.start(), second.start()]);
  const winner = starts[0]?.status === 'fulfilled' ? first : second;
  const loser = winner === first ? second : first;
  try {
    assert.equal(starts.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(starts.filter(({ status }) => status === 'rejected').length, 1);
    await loser.close();
    assert.match((await mimiRpc<{ owner: string }>(socket, 'ping')).owner, /first|second/);
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
  }
});

test('IPC startup recovers a lock left by a dead process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ipc-stale-lock-'));
  const socket = path.join(root, 'mimi.sock');
  const lock = `${socket}.lock`;
  await writeFile(lock, JSON.stringify({
    pid: 2_147_483_647,
    token: 'stale-owner',
    createdAt: '2000-01-01T00:00:00.000Z',
  }));
  const server = new MimiIpcServer(socket, () => ({ ok: true }));
  await server.start();
  try {
    assert.deepEqual(await mimiRpc(socket, 'ping'), { ok: true });
    assert.doesNotMatch(await readFile(lock, 'utf8'), /stale-owner/);
  } finally {
    await server.close();
  }
});

test('client timeout disconnects without accepting a late server result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ipc-timeout-'));
  const socket = path.join(root, 'mimi.sock');
  const release = deferred();
  const server = new MimiIpcServer(socket, async (method) => {
    if (method === 'ping') return { ok: true };
    await release.promise;
    return { tooLate: true };
  });
  await server.start();
  try {
    const rejection = assert.rejects(
      mimiRpc(socket, 'wait', undefined, 50),
      /MimiAgent IPC 超时：wait/,
    );
    await rejection;
    release.resolve();
    assert.deepEqual(await mimiRpc(socket, 'ping'), { ok: true });
  } finally {
    await server.close();
  }
});

test('client AbortSignal disconnects the RPC and aborts queued server work immediately', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ipc-abort-'));
  const socket = path.join(root, 'mimi.sock');
  const started = deferred();
  const aborted = deferred();
  const server = new MimiIpcServer(socket, async (_method, _params, signal) => {
    started.resolve();
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    }
    aborted.resolve();
    return { tooLate: true };
  });
  await server.start();
  try {
    const controller = new AbortController();
    const rejection = assert.rejects(
      mimiRpc(socket, 'wait', undefined, 5_000, controller.signal),
      /stop indexing/,
    );
    await within(started.promise, 2_000, 'IPC handler handshake');
    controller.abort(new Error('stop indexing'));
    await rejection;
    await within(aborted.promise, 2_000, 'IPC handler abort');
  } finally {
    await server.close();
  }
});

test('mimiRpc reports an empty response from a closing MimiIpcServer as ECONNRESET', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ipc-reset-'));
  const socket = path.join(root, 'mimi.sock');
  const started = deferred();
  const server = new MimiIpcServer(socket, async () => {
    started.resolve();
    await new Promise(() => undefined);
  });
  await server.start();
  const pending = mimiRpc(socket, 'wait');
  const rejection = assert.rejects(pending, (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, 'ECONNRESET');
    assert.match(error.message, /响应前关闭/);
    return true;
  });
  await within(started.promise, 2_000, 'IPC reset handler handshake');
  await server.close();
  await rejection;
});

test('mimiRpc still fails closed on a non-empty malformed response', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ipc-malformed-'));
  const socket = path.join(root, 'mimi.sock');
  const server = net.createServer((client) => {
    client.once('data', () => client.end('{not-json\n'));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  try {
    await assert.rejects(mimiRpc(socket, 'status'), SyntaxError);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
