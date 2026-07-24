import type { CaptureInput, CompilationReceipt } from './compiler.js';
import type {
  ForgetReceipt,
  MemoryCard,
  MemoryDocument,
  EpisodeInput,
  MemoryHit,
  MemoryLink,
  MemoryPage,
  MemoryRef,
  MemorySearchOptions,
  MemoryStatusSnapshot,
  RememberInput,
  RunMemoryContext,
  WikiLintReport,
} from './types.js';

export interface MemoryHub {
  hotProfile(context: RunMemoryContext): Promise<MemoryCard[]>;
  search(query: string, context: RunMemoryContext, options?: MemorySearchOptions): Promise<MemoryHit[]>;
  read(ref: MemoryRef, context: RunMemoryContext): Promise<MemoryDocument>;
  links(ref: MemoryRef, context: RunMemoryContext): Promise<MemoryLink[]>;
  remember(input: RememberInput, context: RunMemoryContext): Promise<MemoryPage>;
  forget(ref: MemoryRef, context: RunMemoryContext): Promise<ForgetReceipt>;
  ingest(sourcePath: string, context: RunMemoryContext): Promise<CompilationReceipt>;
  capture(input: CaptureInput, context: RunMemoryContext): Promise<CompilationReceipt>;
  refreshStale(limit: number, context: RunMemoryContext): Promise<CompilationReceipt[]>;
  reject(sourceRefs: import('./types.js').SourceRef[], reasonCode: string, context: RunMemoryContext): Promise<CompilationReceipt>;
  recordEpisode(input: EpisodeInput, context: RunMemoryContext): Promise<MemoryRef>;
  conflicts(context: RunMemoryContext, limit?: number): Promise<MemoryHit[]>;
  audit(context: RunMemoryContext, limit?: number): Promise<import('./types.js').MemoryDecisionEvent[]>;
  list(context: RunMemoryContext, options?: MemorySearchOptions): Promise<MemoryHit[]>;
  lint(context: RunMemoryContext): Promise<WikiLintReport>;
  reindex(context: RunMemoryContext): Promise<MemoryStatusSnapshot>;
  status(context: RunMemoryContext): Promise<MemoryStatusSnapshot>;
}
