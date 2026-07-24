import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { loadEnvironment } from './config.js';

type CanaryProvider = 'openai' | 'deepseek';

interface ProviderCanaryCase {
  provider: CanaryProvider;
  apiKeyEnvironment: string;
  input: string;
  expectedTools: string[];
  expectedOutput: string;
}

interface ProviderCanaryFixture {
  schemaVersion: number;
  cases: ProviderCanaryCase[];
}

interface ProviderCanaryResult {
  provider: CanaryProvider;
  status: 'passed' | 'failed';
  durationMs: number;
  missingTools: string[];
  expectedOutputFound: boolean;
  error?: string;
}

interface ProviderCanaryReport {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  node: string;
  platform: string;
  results: ProviderCanaryResult[];
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function selectedProviders(): CanaryProvider[] {
  const selected = argumentValue('--provider') ?? 'all';
  if (selected === 'all') return ['openai', 'deepseek'];
  if (selected === 'openai' || selected === 'deepseek') return [selected];
  throw new Error('--provider must be openai, deepseek, or all');
}

async function runCase(root: string, item: ProviderCanaryCase): Promise<ProviderCanaryResult> {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), `mimi-${item.provider}-canary-`));
  const started = Date.now();
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', item.input], {
        cwd: root,
        env: {
          ...process.env,
          MIMI_DATA_DIR: dataRoot,
          MIMI_SESSION: `provider-canary-${item.provider}`,
          MIMI_MAX_TURNS: '6',
          MIMI_MODEL_PROVIDER: item.provider,
          MIMI_OUTPUT_LEVEL: 'trace',
          MIMI_SECURITY_PROFILE: 'safe',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('timed out after 90 seconds'));
      }, 90_000);
      child.stdout.on('data', (chunk) => {
        text += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        text += String(chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(text);
        else reject(new Error(`CLI exited with code ${code ?? 'unknown'}`));
      });
    });
    const missingTools = item.expectedTools.filter((name) => !output.includes(`工具  ${name}`));
    const expectedOutputFound = output.includes(item.expectedOutput);
    return {
      provider: item.provider,
      status: missingTools.length === 0 && expectedOutputFound ? 'passed' : 'failed',
      durationMs: Date.now() - started,
      missingTools,
      expectedOutputFound,
    };
  } catch (error) {
    return {
      provider: item.provider,
      status: 'failed',
      durationMs: Date.now() - started,
      missingTools: [...item.expectedTools],
      expectedOutputFound: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  loadEnvironment();
  const providers = selectedProviders();
  const fixture = JSON.parse(
    await readFile(path.join(root, 'evals', 'provider-canary.json'), 'utf8'),
  ) as ProviderCanaryFixture;
  if (fixture.schemaVersion !== 1) throw new Error('unsupported provider canary schema');
  const cases = fixture.cases.filter((item) => providers.includes(item.provider));
  const missingCredentials = cases
    .filter((item) => !process.env[item.apiKeyEnvironment])
    .map((item) => item.apiKeyEnvironment);
  if (missingCredentials.length > 0) {
    throw new Error(`missing Provider canary credentials: ${[...new Set(missingCredentials)].join(', ')}`);
  }

  const startedAt = new Date().toISOString();
  const results: ProviderCanaryResult[] = [];
  for (const item of cases) {
    const result = await runCase(root, item);
    results.push(result);
    const details = result.status === 'passed'
      ? `${result.durationMs} ms`
      : result.error ?? `missing tools: ${result.missingTools.join(', ') || 'none'}; output match: ${result.expectedOutputFound}`;
    console.log(`${result.status === 'passed' ? '✓' : '✗'} ${item.provider}: ${details}`);
  }
  const report: ProviderCanaryReport = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    results,
  };
  const output = argumentValue('--output');
  if (output) {
    await writeFile(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  }
  if (results.some((result) => result.status !== 'passed')) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
