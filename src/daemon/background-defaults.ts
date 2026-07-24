export const BACKGROUND_DEFAULTS_VERSION = 1;

const DEFAULT_MACOS_CONNECTORS = new Set([
  'macos-system',
]);

export const LEGACY_VISIBLE_MACOS_CONNECTORS = [
  'macos-life',
  'macos-mail',
  'macos-messages',
  'macos-contacts',
  'macos-notes',
  'macos-shortcuts',
  'macos-desktop',
  'macos-browser',
  'macos-screen',
  'macos-voice',
] as const;

export function defaultConnectorEnabled(id: string, platform: NodeJS.Platform): boolean {
  return platform === 'darwin' && DEFAULT_MACOS_CONNECTORS.has(id);
}

export function legacyVisibleConnectorsToDisable(
  currentVersion: number,
  enabled: Readonly<Record<string, boolean>>,
  canonical: ReadonlySet<string>,
): { version: number; disabled: string[]; changed: boolean } {
  if (currentVersion >= BACKGROUND_DEFAULTS_VERSION) {
    return { version: currentVersion, disabled: [], changed: false };
  }
  const disabled = LEGACY_VISIBLE_MACOS_CONNECTORS.filter((id) => (
    enabled[id] === true && canonical.has(id)
  ));
  return {
    version: BACKGROUND_DEFAULTS_VERSION,
    disabled,
    changed: true,
  };
}
