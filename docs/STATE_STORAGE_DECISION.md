# State storage decision: ports and commit journal before SQLite convergence

Status: accepted, 2026-07-24.

MimiAgent keeps Session transcripts, Goal/Plan, Team state, execution ledgers and
traces in their existing file-backed stores for this release. Runtime construction
goes through explicit state ports, and cross-store run completion is fenced by a
`RunCommitJournal`. The journal stores only identifiers, answer digests, phases and
bounded RuntimeAction descriptors; it never stores answer text or credentials.

We are not moving these stores into Daemon SQLite yet. CLI/offline consumers still
read the file formats, Session uses the OpenAI SDK-compatible `FileSession`
adapter, and a combined migration would expand the recovery surface while Memory
V2 and the Daemon v15 migration are landing. Long-lived dual writes are forbidden.

A later SQLite cutover requires all of the following:

- one Kernel owns every mutation, including offline commands;
- backup/restore covers every proposed table and WAL state;
- empty, legacy, corrupt and concurrent migration tests pass;
- public APIs no longer rely on the JSON representation;
- conversion is offline, validated and marked before the new store becomes the
  sole reader and writer.

Until then, completion recovery uses the existing execution receipt as the
answer/action payload and the journal as the phase authority. A retained
completion receipt is never cleared merely because a later Session or Goal commit
failed; restart recovery reconciles the Session and reapplies RuntimeActions
through their at-most-once ledger.
