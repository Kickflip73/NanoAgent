import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface AgentEvalCase {
  name: string;
  input: string;
  expectedTools: string[];
  env?: Record<string, string>;
}

const root = process.cwd();
const cases = JSON.parse(await readFile(path.join(root, 'evals', 'agent-cases.json'), 'utf8')) as AgentEvalCase[];
let passed = 0;

for (const item of cases) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-eval-'));
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', item.input], {
        cwd: root,
        env: {
          ...process.env,
          MIMI_DATA_DIR: dataRoot,
          MIMI_SESSION: 'eval',
          MIMI_MAX_TURNS: '12',
          MIMI_OUTPUT_LEVEL: 'trace',
          ...item.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
      child.stdout.on('data', (chunk) => { text += String(chunk); });
      child.stderr.on('data', (chunk) => { text += String(chunk); });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(text);
        else reject(new Error(`Agent eval 退出码 ${code}\n${text}`));
      });
    });
    const missing = item.expectedTools.filter((name) => !output.includes(`工具  ${name}`));
    const ok = missing.length === 0;
    console.log(`${ok ? '✓' : '✗'} ${item.name} → ${item.expectedTools.join(', ')}${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
    if (ok) passed += 1;
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

console.log(`\n${passed}/${cases.length} agent behavior evals passed`);
if (passed !== cases.length) process.exitCode = 1;
