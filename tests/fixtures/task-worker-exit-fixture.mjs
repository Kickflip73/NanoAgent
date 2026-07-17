import process from 'node:process';

process.on('message', (message) => {
  if (!message || typeof message !== 'object' || message.type !== 'init') return;
  process.disconnect();
});
