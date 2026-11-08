import { describe, expect, it, vi } from 'vitest';
import { CARD_FONTS, startFonts } from '../src/fonts';

function doc(over: { load?: (f: string) => Promise<unknown>; check?: (f: string) => boolean } = {}) {
  const load = vi.fn(over.load ?? (() => Promise.resolve([])));
  const check = vi.fn(over.check ?? (() => false));
  return { d: { fonts: { load, check } } as unknown as Document, load, check };
}

describe('startFonts', () => {
  it('is null (nothing to wait for) when the document has no font API', () => {
    expect(startFonts({} as Document)).toBeNull();
  });

  it('is null when every card font is already loaded', () => {
    const { d, load } = doc({ check: () => true });
    expect(startFonts(d)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('asks for every card font at once and settles when they are in', async () => {
    let done!: () => void;
    const gate = new Promise<unknown>((r) => (done = () => r([])));
    const { d, load } = doc({ load: () => gate });
    const p = startFonts(d, 10_000)!;
    expect(load.mock.calls.map((c) => c[0])).toEqual(CARD_FONTS);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    done();
    await expect(p).resolves.toBe('loaded');
    expect(settled).toBe(true);
  });

  it('settles after the cap when the fonts are slow, and never rejects', async () => {
    vi.useFakeTimers();
    try {
      const { d } = doc({ load: () => new Promise(() => {}) });
      const p = startFonts(d, 1500)!;
      let settled = false;
      void p.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(1499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await expect(p).resolves.toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles when a font fails to load (an unserved card falls back to system fonts)', async () => {
    const { d } = doc({ load: () => Promise.reject(new Error('404')) });
    await expect(startFonts(d, 10_000)).resolves.toBe('loaded');
  });
});
