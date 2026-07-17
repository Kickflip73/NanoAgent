import process from 'node:process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

let taskId;
let databasePath;
let heartbeat;
let stopping = false;

function send(message) {
  if (process.connected) process.send(message);
}

function disconnect() {
  if (!process.connected) return;
  try {
    process.disconnect();
  } catch (error) {
    if (error?.code !== 'ERR_IPC_DISCONNECTED') throw error;
  }
}

async function initialize(message) {
  taskId = message.taskId;
  databasePath = message.database;
  const capture = process.env.TASK_WORKER_INIT_CAPTURE;
  if (capture) {
    const mcpEnvironment = message.mcpEnvironment ?? {};
    await mkdir(capture, { recursive: true });
    await writeFile(path.join(capture, `${taskId}.json`), JSON.stringify({
      taskId,
      socket: message.socket,
      workerToken: message.workerToken,
      workspaceAccess: message.workspaceAccess,
      enableMcp: message.enableMcp,
      provider: message.providerCredential?.provider,
      providerCredentialPresent: typeof message.providerCredential?.apiKey === 'string'
        && message.providerCredential.apiKey.length > 0,
      embeddingCredentialPresent: typeof message.embeddingCredential?.apiKey === 'string'
        && message.embeddingCredential.apiKey.length > 0,
      mcpEnvironmentNames: Object.keys(mcpEnvironment).sort(),
      mcpEnvironmentDigest: createHash('sha256').update(JSON.stringify(mcpEnvironment)).digest('hex'),
      workerEnvironmentProviderKey: process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY,
      workerEnvironmentMcpValue: process.env.MCP_TASK_VALUE,
      workerEnvironmentPathPresent: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,
      redactedSecret: process.env.CONNECTOR_TEST_SECRET,
    }), { mode: 0o600 });
  }
  if (stopping) return;
  const workerId = `fixture-${process.pid}`;
  const database = new DatabaseSync(message.database, { timeout: 5_000 });
  database.exec('PRAGMA busy_timeout=5000;');
  const now = new Date();
  database.prepare(`
    UPDATE events SET status = 'running', attempts = attempts + 1,
      lease_owner = ?, lease_until = ?, updated_at = ?
    WHERE id = ? AND status = 'queued'
  `).run(workerId, new Date(now.getTime() + 60_000).toISOString(), now.toISOString(), taskId);
  database.close();
  send({
    type: 'started',
    taskId,
    workerId,
    pid: process.pid,
  });
  const beat = () => send({
    type: 'heartbeat',
    taskId,
    at: new Date().toISOString(),
  });
  beat();
  heartbeat = setInterval(beat, 25);
}

function finishControl(status, reason) {
  stopping = true;
  if (heartbeat) clearInterval(heartbeat);
  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  database.exec('PRAGMA busy_timeout=5000;');
  database.prepare(`
    UPDATE events SET status = ?, attempts = CASE WHEN ? = 'paused' THEN MAX(0, attempts - 1) ELSE attempts END,
      error = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
    WHERE id = ? AND status = 'running'
  `).run(status, status, reason, new Date().toISOString(), taskId);
  database.close();
  send({ type: 'done', taskId, processed: true, status });
  disconnect();
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'init') {
    void initialize(message);
    return;
  }
  if (message.type === 'shutdown') {
    stopping = true;
    if (heartbeat) clearInterval(heartbeat);
    disconnect();
    return;
  }
  if (message.type === 'pause' && message.taskId === taskId) finishControl('paused', message.reason);
  if (message.type === 'cancel' && message.taskId === taskId) finishControl('archived', message.reason);
});

process.on('disconnect', () => {
  if (heartbeat) clearInterval(heartbeat);
});

process.on('error', (error) => {
  if (error?.code !== 'ERR_IPC_DISCONNECTED') throw error;
});
