import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryHub } from './extensions/memory/hub.js';

interface EvalCase {
  query: string;
  expectedSource: string;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-eval-'));
  const temporaryData = path.join(temporaryRoot, '.mimi-agent');
  const cases = JSON.parse(await readFile(path.join(root, 'evals', 'cases.json'), 'utf8')) as EvalCase[];
  const sources = [...new Set(cases.map((item) => item.expectedSource))];
  for (const source of sources) {
    const destination = path.join(temporaryRoot, source);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, source), destination);
  }
  const hub = await createMemoryHub({ workspaceRoot: temporaryRoot, dataRoot: temporaryData, profileId: 'eval', cutover: false });
  const context = { profileId: 'eval', workspaceRoot: temporaryRoot, sessionId: 'eval', runId: 'eval', cause: { trust: 'owner' as const, source: 'eval' } };
  for (const source of sources) await hub.ingest(source, context);
  let passed = 0;
  for (const item of cases) {
    const matches = await hub.search(item.query, context, { scope: 'workspace', limit: 3 });
    const ok = matches.some((match) => match.sourceRefs.some((source) => source.id === item.expectedSource));
    console.log(`${ok ? '✓' : '✗'} ${item.query}`);
    if (ok) passed += 1;
  }
  await rm(temporaryRoot, { recursive: true, force: true });
  console.log(`\n${passed}/${cases.length} retrieval evals passed`);
  if (passed !== cases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
