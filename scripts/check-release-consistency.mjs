import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

assert.equal(lock.version, manifest.version, 'package-lock version differs from package version');
assert.equal(lock.packages?.['']?.version, manifest.version, 'lockfile root version differs from package version');
assert.match(manifest.packageManager ?? '', /^npm@\d+\.\d+\.\d+$/, 'packageManager must pin npm exactly');

const pinnedDependencies = ['@openai/agents', 'openai', 'ws', 'zod'];
for (const name of pinnedDependencies) {
  assert.match(manifest.dependencies[name], /^\d+\.\d+\.\d+$/, `${name} must use an exact version`);
  assert.equal(lock.packages[''].dependencies[name], manifest.dependencies[name], `${name} differs in lockfile root`);
}
assert.match(manifest.devDependencies.typescript, /^\d+\.\d+\.\d+$/, 'typescript must use an exact version');
assert.equal(lock.packages[''].devDependencies.typescript, manifest.devDependencies.typescript);

const sdkVersion = manifest.dependencies['@openai/agents'];
for (const name of ['@openai/agents-core', '@openai/agents-openai', '@openai/agents-realtime']) {
  assert.equal(manifest.overrides?.[name], sdkVersion, `${name} override must match @openai/agents`);
  assert.equal(lock.packages[`node_modules/${name}`]?.version, sdkVersion, `${name} lock version must match @openai/agents`);
}
assert.match(manifest.overrides?.['fast-uri'] ?? '', /^\d+\.\d+\.\d+$/, 'fast-uri security override must be exact');
assert.equal(lock.packages['node_modules/fast-uri']?.version, manifest.overrides['fast-uri']);

const unreleasedHeadings = changelog.match(/^## \[?Unreleased\]?$/gm) ?? [];
assert.equal(unreleasedHeadings.length, 1, 'CHANGELOG must contain exactly one Unreleased section');
assert.match(changelog, new RegExp(`^## \\[${manifest.version.replaceAll('.', '\\.')}\\]`, 'm'), `CHANGELOG lacks ${manifest.version}`);

if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, `v${manifest.version}`, 'release tag differs from package version');
}

console.log(`Release consistency check passed for ${manifest.version}.`);
