export const MAX_MEMORY_EVIDENCE_SNAPSHOT_BYTES = 8 * 1024;

export interface BoundedMemoryEvidenceSnapshot {
  objective: unknown;
  result?: unknown;
  error?: string;
}

interface EvidencePreview {
  originalBytes: number;
  preview: string;
  truncated: true;
}

function serialized(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function preview(value: unknown, characters: number): EvidencePreview {
  const text = serialized(value);
  return {
    originalBytes: Buffer.byteLength(text),
    preview: text.slice(0, characters),
    truncated: true,
  };
}

function snapshotBytes(snapshot: BoundedMemoryEvidenceSnapshot): number {
  return Buffer.byteLength(JSON.stringify(snapshot));
}

export function boundedMemoryEvidenceSnapshot(
  objective: unknown,
  result: unknown,
  error?: string,
): BoundedMemoryEvidenceSnapshot {
  const complete: BoundedMemoryEvidenceSnapshot = {
    objective,
    ...(result === undefined ? {} : { result }),
    ...(error ? { error: error.slice(0, 2_000) } : {}),
  };
  if (snapshotBytes(complete) <= MAX_MEMORY_EVIDENCE_SNAPSHOT_BYTES) return complete;

  let objectiveCharacters = 1_500;
  let resultCharacters = 4_500;
  let errorCharacters = 500;
  let bounded: BoundedMemoryEvidenceSnapshot;
  do {
    bounded = {
      objective: preview(objective, objectiveCharacters),
      ...(result === undefined ? {} : { result: preview(result, resultCharacters) }),
      ...(error ? { error: error.slice(0, errorCharacters) } : {}),
    };
    if (snapshotBytes(bounded) <= MAX_MEMORY_EVIDENCE_SNAPSHOT_BYTES) return bounded;
    if (resultCharacters >= objectiveCharacters && resultCharacters > 100) {
      resultCharacters = Math.max(100, resultCharacters - 250);
    } else if (objectiveCharacters > 100) {
      objectiveCharacters = Math.max(100, objectiveCharacters - 100);
    } else {
      errorCharacters = Math.max(0, errorCharacters - 50);
    }
  } while (objectiveCharacters > 100 || resultCharacters > 100 || errorCharacters > 0);

  if (snapshotBytes(bounded!) > MAX_MEMORY_EVIDENCE_SNAPSHOT_BYTES) {
    throw new Error('无法将 Task 终态证据压缩到 8KB 以内');
  }
  return bounded!;
}
