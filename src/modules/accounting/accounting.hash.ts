/**
 * accounting.hash.ts
 * Immutable ledger hash chain.
 * Each entry: sha256(seq + "|" + amount + "|" + type + "|" + sourceId + "|" + prevHash)
 */
import { createHash } from 'node:crypto';

export function computeEntryHash(params: {
  seq: number;
  amount: number;
  type: string;
  sourceId: string | null | undefined;
  prevHash: string | null | undefined;
}): string {
  const raw = [
    params.seq.toString(),
    params.amount.toFixed(4),
    params.type,
    params.sourceId ?? '',
    params.prevHash ?? 'GENESIS',
  ].join('|');
  return createHash('sha256').update(raw).digest('hex');
}

export function verifyChain(entries: Array<{ seq: number; amount: number; type: string; sourceId: string | null; prevHash: string | null; hash: string }>): {
  valid: boolean;
  brokenAt?: number;
} {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) {
      continue;
    }
    const expected = computeEntryHash({
      seq: e.seq,
      amount: e.amount,
      type: e.type,
      sourceId: e.sourceId,
      prevHash: e.prevHash,
    });
    if (expected !== e.hash) {
      return { valid: false, brokenAt: e.seq };
    }
  }
  return { valid: true };
}
