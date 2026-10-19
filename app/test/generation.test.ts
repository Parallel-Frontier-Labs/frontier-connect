import { describe, expect, it } from 'vitest';
import { Generations } from '../src/generation';

describe('Generations', () => {
  it('a result is current only if neither the view nor the query moved while it was pending', async () => {
    const g = new Generations();
    let release!: (v: string) => void;
    const pending = g.run(() => new Promise<string>((r) => (release = r)));
    release('a');
    expect(await pending).toEqual({ stale: false, value: 'a' });
    for (const bump of [() => g.bumpView(), () => g.bumpQuery()]) {
      const p = g.run(() => new Promise<string>((r) => (release = r)));
      bump();
      release('b');
      // The value is still handed back (a deletion that landed is a fact) but marked stale.
      expect(await p).toEqual({ stale: true, value: 'b' });
    }
  });

  it('runs under an explicit tag (the poll session) and passes rejections through', async () => {
    const g = new Generations();
    const t = g.tag();
    g.bumpView();
    expect((await g.run(Promise.resolve(1), t)).stale).toBe(true);
    await expect(g.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
  });
});
