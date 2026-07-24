import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BACKGROUND_DEFAULTS_VERSION,
  defaultConnectorEnabled,
  LEGACY_VISIBLE_MACOS_CONNECTORS,
  legacyVisibleConnectorsToDisable,
} from '../src/daemon/background-defaults.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('fresh macOS background defaults enable only the non-UI system connector', () => {
  assert.equal(BACKGROUND_DEFAULTS_VERSION, 1);
  assert.equal(defaultConnectorEnabled('macos-system', 'darwin'), true);
  for (const id of LEGACY_VISIBLE_MACOS_CONNECTORS) {
    assert.equal(defaultConnectorEnabled(id, 'darwin'), false);
  }
  assert.equal(defaultConnectorEnabled('macos-system', 'linux'), false);
});

test('legacy canonical defaults are silenced once and later explicit opt-in is preserved', () => {
  const enabled = Object.fromEntries(
    LEGACY_VISIBLE_MACOS_CONNECTORS.map((id) => [id, true]),
  );
  const canonical = new Set(LEGACY_VISIBLE_MACOS_CONNECTORS);
  const migration = legacyVisibleConnectorsToDisable(0, enabled, canonical);
  assert.equal(migration.version, 1);
  assert.deepEqual(migration.disabled, [...LEGACY_VISIBLE_MACOS_CONNECTORS]);
  assert.equal(migration.changed, true);

  const explicit = legacyVisibleConnectorsToDisable(1, enabled, canonical);
  assert.deepEqual(explicit, { version: 1, disabled: [], changed: false });
  const custom = legacyVisibleConnectorsToDisable(0, enabled, new Set());
  assert.deepEqual(custom, { version: 1, disabled: [], changed: true });
});

test('background data access avoids launching closed GUI applications', async () => {
  const [life, mail] = await Promise.all([
    readFile(path.join(projectRoot, 'examples/connectors/macos-life-connector.mjs'), 'utf8'),
    readFile(path.join(projectRoot, 'examples/connectors/macos-mail-connector.mjs'), 'utf8'),
  ]);
  assert.match(life, /runEventKit\(message\.action, message\.target, payload\)/);
  assert.match(life, /runEventKit\('poll', '\*'/);
  assert.match(mail, /if \(!app\.running\(\)\) return JSON\.stringify\(\{ messages: \[\] \}\)/);
});
