import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

if (process.argv[2] === '--late-write') {
  process.on('SIGTERM', () => undefined);
  setTimeout(() => {
    void writeFile(process.argv[3], 'orphan').finally(() => process.exit());
  }, 400);
} else {
  let keepAlive;
  process.on('message', (message) => {
    if (!message || message.type !== 'init') return;
    const marker = process.env.TASK_WORKER_ORPHAN_MARKER;
    if (!marker) throw new Error('TASK_WORKER_ORPHAN_MARKER is required');
    spawn(process.execPath, [process.argv[1], '--late-write', marker], {
      detached: false,
      stdio: 'ignore',
    });
    if (process.connected) {
      process.send({
        type: 'started',
        taskId: message.taskId,
        workerId: `orphan-fixture-${process.pid}`,
        pid: process.pid,
      });
    }
    keepAlive = setInterval(() => undefined, 1_000);
  });
  process.on('disconnect', () => clearInterval(keepAlive));
}
