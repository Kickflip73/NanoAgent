import process from 'node:process';

const keepAlive = setInterval(() => undefined, 1_000);

process.on('SIGTERM', () => undefined);
process.on('message', () => undefined);
process.on('disconnect', () => clearInterval(keepAlive));
