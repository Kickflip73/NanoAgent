import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const sourceRoot = path.resolve('src');
const knownReverseEdges = new Set();

function filesUnder(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    return statSync(absolute).isDirectory() ? filesUnder(absolute) : [absolute];
  });
}

function targetFor(source, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const resolved = path.resolve(path.dirname(source), specifier).replace(/\.js$/, '.ts');
  if (!resolved.startsWith(`${sourceRoot}${path.sep}`)) return undefined;
  return path.relative(sourceRoot, resolved).split(path.sep).join('/');
}

const violations = [];
const observedReverseEdges = new Set();
for (const source of filesUnder(sourceRoot).filter((file) => file.endsWith('.ts'))) {
  const relativeSource = path.relative(sourceRoot, source).split(path.sep).join('/');
  const content = readFileSync(source, 'utf8');
  const imports = content.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g);
  for (const match of imports) {
    const target = targetFor(source, match[1]);
    if (!target) continue;
    const edge = `${relativeSource} -> ${target}`;
    if (relativeSource.startsWith('core/')
      && /^(runtime|daemon|extensions)\//.test(target)) {
      violations.push(`${edge}: core cannot depend on runtime, daemon, or extensions`);
    }
    if (relativeSource.startsWith('extensions/') && target.startsWith('runtime/')) {
      observedReverseEdges.add(edge);
      if (!knownReverseEdges.has(edge)) violations.push(`${edge}: new extensions -> runtime reverse dependency`);
    }
    if (relativeSource.startsWith('daemon/') && target === 'interactive.ts') {
      observedReverseEdges.add(edge);
      if (!knownReverseEdges.has(edge)) violations.push(`${edge}: new daemon -> terminal UI dependency`);
    }
    if (relativeSource.startsWith('daemon/persistence/')
      && !target.startsWith('daemon/persistence/')) {
      violations.push(`${edge}: persistence schema must remain runtime-independent`);
    }
  }
}

for (const edge of knownReverseEdges) {
  if (!observedReverseEdges.has(edge)) {
    violations.push(`${edge}: stale dependency allowlist entry; remove it from the checker`);
  }
}

if (violations.length > 0) {
  console.error('Dependency direction check failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `Dependency direction check passed (${knownReverseEdges.size} explicit legacy reverse edges, no new violations).`,
);
