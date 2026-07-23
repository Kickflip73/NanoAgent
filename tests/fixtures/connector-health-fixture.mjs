import { readFileSync, writeFileSync } from 'node:fs';

const marker = process.argv[2];
const failures = Number(process.argv[3] ?? 0);
if (!marker || !Number.isSafeInteger(failures) || failures < 0) process.exit(64);

let attempt = 0;
try {
  attempt = Number(readFileSync(marker, 'utf8')) || 0;
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
attempt += 1;
writeFileSync(marker, String(attempt), { mode: 0o600 });

if (attempt <= failures) {
  setTimeout(() => process.exit(17), 20);
} else {
  setInterval(() => undefined, 1_000);
}
