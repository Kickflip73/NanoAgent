const SAFE_ENVIRONMENT_NAMES = new Set([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'SHELL', 'USER', 'LOGNAME', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'TZ', 'CI',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'USERPROFILE',
]);

/** Environment visible to model-authored Shell commands. Provider and control
 * credentials stay in the Host process and are never ambient Shell input. */
export function restrictedShellEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => (
    SAFE_ENVIRONMENT_NAMES.has(name.toUpperCase()) || name.toUpperCase().startsWith('LC_')
  )));
}
