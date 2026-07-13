import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { RagStore } from './extensions/rag.js';

interface EvalCase {
  query: string;
  expectedSource: string;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const temporaryIndex = path.join(root, '.nano-agent', 'eval-rag-index.json');
  const cases = JSON.parse(await readFile(path.join(root, 'evals', 'cases.json'), 'utf8')) as EvalCase[];
  const rag = new RagStore(root, temporaryIndex);
  await rag.index('knowledge');
  let passed = 0;
  for (const item of cases) {
    const matches = await rag.search(item.query, 3);
    const ok = matches.some((match) => match.source === item.expectedSource);
    console.log(`${ok ? '✓' : '✗'} ${item.query}`);
    if (ok) passed += 1;
  }
  await rm(temporaryIndex, { force: true });
  console.log(`\n${passed}/${cases.length} retrieval evals passed`);
  if (passed !== cases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
