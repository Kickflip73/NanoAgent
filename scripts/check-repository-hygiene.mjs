import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const forbiddenPaths = [
  /^data(?:\/|$)/,
  /^\.playwright-cli(?:\/|$)/,
  /(?:^|\/)[^/]+\.db(?:-wal|-shm)?$/,
  /(?:^|\/)(?:screenshots|recordings|computer-artifacts)(?:\/|$)/,
  /(?:^|\/)[^/]+\.local-identity$/,
];

const secretPatterns = [
  { name: 'private key', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'GitHub token', pattern: /\bgh[opusr]_[A-Za-z0-9]{20,}\b/ },
];

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const violations = [];

for (const file of tracked) {
  if (!existsSync(file)) continue;
  if (forbiddenPaths.some((pattern) => pattern.test(file))) {
    violations.push(`${file}: forbidden runtime or private artifact`);
    continue;
  }
  const absolute = path.resolve(file);
  let content;
  try {
    const buffer = readFileSync(absolute);
    if (buffer.includes(0) || buffer.length > 2_000_000) continue;
    content = buffer.toString('utf8');
  } catch {
    continue;
  }
  for (const candidate of secretPatterns) {
    if (candidate.pattern.test(content)) {
      violations.push(`${file}: possible ${candidate.name}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Repository hygiene check failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Repository hygiene check passed (${tracked.length} tracked files).`);
