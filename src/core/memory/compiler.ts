import type { MemoryConfidence, MemoryKind, MemoryRef, MemoryStatus, RunMemoryContext, SourceRef, WikiLintReport } from './types.js';

export type CompilationOperation = 'ingest' | 'capture' | 'lint';
export type CompilationStatus = 'pending' | 'applied' | 'rejected';

export interface CompilationPlan {
  operation: CompilationOperation;
  digest: string;
  compilerVersion: string;
  plannedPageRefs: MemoryRef[];
  appliedPageRefs: MemoryRef[];
}

export interface CompilationReceipt {
  id: string;
  operation: CompilationOperation;
  status: CompilationStatus;
  digest: string;
  pageRefs: MemoryRef[];
  reasonCode?: string;
}

export interface CaptureInput {
  title: string;
  content: string;
  sourceRefs: SourceRef[];
  scope?: 'private' | 'workspace';
  kind?: MemoryKind;
  status?: MemoryStatus;
  confidence?: MemoryConfidence;
  reasonCode?: string;
  supersedes?: string[];
}

export interface WikiCompiler {
  ingest(source: SourceRef, context: RunMemoryContext): Promise<CompilationReceipt>;
  capture(input: CaptureInput, context: RunMemoryContext): Promise<CompilationReceipt>;
  reject(sourceRefs: SourceRef[], reasonCode: string, context: RunMemoryContext): Promise<CompilationReceipt>;
  lint(context: RunMemoryContext): Promise<WikiLintReport>;
}
