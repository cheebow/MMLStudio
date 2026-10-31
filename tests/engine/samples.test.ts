// Every built-in sample must compile without diagnostics (SPEC 9 Phase 5: samples in sync).
import { describe, expect, it } from 'vitest';
import { compileMml } from '../../src/engine';
import { SAMPLES } from '../../src/samples';

describe('built-in samples', () => {
  for (const s of SAMPLES) {
    it(`${s.id} compiles cleanly`, () => {
      const r = compileMml(s.source);
      expect(r.diagnostics).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }
});
