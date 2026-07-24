import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(root, 'skills', 'manifest.json'), 'utf8'));
const packageManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

assert.equal(manifest.schemaVersion, 1, 'unsupported skills manifest schema');
assert.ok(Array.isArray(manifest.skills), 'skills manifest must contain a skills array');

const names = manifest.skills.map((skill) => skill.name);
assert.equal(new Set(names).size, names.length, 'skills manifest contains duplicate names');
for (const skill of manifest.skills) {
  assert.match(skill.name, /^[a-z0-9][a-z0-9-]*$/, `invalid skill name: ${skill.name}`);
  assert.ok(['product', 'experimental'].includes(skill.status), `invalid status for ${skill.name}`);
  assert.equal(
    skill.published,
    skill.status === 'product',
    `${skill.name} publication flag must match its product status`,
  );
}

const skillDirectories = readdirSync(path.join(root, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(path.join(root, 'skills', name, 'SKILL.md')))
  .sort();
assert.deepEqual([...names].sort(), skillDirectories, 'every checked-in Skill must be classified');

const packageFiles = new Set(packageManifest.files);
for (const skill of manifest.skills) {
  const packagePath = `skills/${skill.name}`;
  assert.equal(
    packageFiles.has(packagePath),
    skill.published,
    `${packagePath} package inclusion does not match skills/manifest.json`,
  );
}

assert.ok(packageFiles.has('knowledge/mimi-agent.md'), 'product knowledge must be published explicitly');
assert.ok(!packageFiles.has('knowledge'), 'personal or generated knowledge must not be broadly published');
for (const rootName of ['products', 'projects', 'web-articles']) {
  assert.ok(!packageFiles.has(rootName), `${rootName} is a workspace asset and must not be published`);
}

console.log(
  `Asset boundary check passed (${manifest.skills.filter((skill) => skill.published).length} product Skills, `
  + `${manifest.skills.filter((skill) => !skill.published).length} experimental Skills).`,
);
