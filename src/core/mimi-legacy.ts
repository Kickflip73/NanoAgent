/**
 * Read-only identifiers used to discover data created before the MimiAgent rename.
 * Keep compatibility literals in this migration boundary; production symbols and
 * newly created files must use MimiAgent names.
 */
export const PRE_MIMI_DATA_DIRECTORY = '.nano-agent';
export const PRE_MIMI_DAEMON_DIRECTORY = 'jarvis';
export const PRE_MIMI_DAEMON_FILES = {
  database: 'jarvis.db',
  socket: 'jarvis.sock',
  stdoutLog: 'jarvis.out.log',
  stderrLog: 'jarvis.err.log',
} as const;
