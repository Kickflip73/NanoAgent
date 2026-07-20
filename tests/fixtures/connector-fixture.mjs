process.stdout.write(`${JSON.stringify({
  type: 'status', inbound: 'unknown', outbound: 'ready', deliveryConfirmed: true,
  eventAcknowledgement: true,
})}\n`);
process.stdout.write(`${JSON.stringify({
  type: 'event',
  externalId: 'fixture-event-1',
  kind: 'webhook',
  payload: {
    allowed: process.env.CONNECTOR_TEST_ALLOWED,
    leakedSecret: process.env.CONNECTOR_TEST_SECRET !== undefined,
  },
  priority: 70,
  replyTarget: 'fixture-user',
})}\n`);

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  while (input.includes('\n')) {
    const newline = input.indexOf('\n');
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type === 'event_ack') {
      process.stdout.write(`${JSON.stringify({
        type: 'status', inbound: message.ok ? 'ready' : 'unavailable',
        outbound: 'ready', deliveryConfirmed: true, eventAcknowledgement: true,
      })}\n`);
    } else if (message.type === 'deliver') {
      process.stdout.write(`${JSON.stringify({
        type: 'delivery_ack', id: message.id, ok: message.target !== 'uncertain',
        ...(message.target === 'uncertain' ? { uncertain: true, error: 'fixture result uncertain' } : {}),
      })}\n`);
    } else if (message.type === 'action') {
      if (message.target === 'exit') process.exit(17);
      if (message.target === 'hang') continue;
      if (message.target === 'uncertain') {
        process.stdout.write(`${JSON.stringify({
          type: 'action_result', id: message.id, ok: false, uncertain: true,
          error: 'fixture action result uncertain',
        })}\n`);
        continue;
      }
      const respond = () => process.stdout.write(`${JSON.stringify({
          type: 'action_result',
          id: message.id,
          ok: true,
          result: { requestId: message.id, action: message.action, target: message.target, payload: message.payload },
        })}\n`);
      if (message.target === 'delay') setTimeout(respond, 100);
      else respond();
    }
  }
});
