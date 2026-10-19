/**
 * Every server call the card makes goes through `Generations.run`. A call is tagged with the view
 * generation (bumped on every navigation: open, back, a host tool result) and the query generation
 * (bumped on every list request and every list from the host). When it settles, its result is
 * applied only if both are unchanged; otherwise it is reported as stale and dropped.
 */
export interface Tag { view: number; query: number }
/** `value` is there either way (a deletion that landed late is still a fact); apply it only when not stale. */
export type Guarded<T> = { stale: boolean; value: T };

export class Generations {
  view = 0;
  query = 0;
  bumpView(): void {
    this.view++;
  }
  bumpQuery(): void {
    this.query++;
  }
  tag(): Tag {
    return { view: this.view, query: this.query };
  }
  current(t: Tag): boolean {
    return t.view === this.view && t.query === this.query;
  }
  /** Settle `call` (a promise, or a function returning one) under the current tag. Rejections pass through. */
  async run<T>(call: Promise<T> | (() => Promise<T>), t: Tag = this.tag()): Promise<Guarded<T>> {
    const value = await (typeof call === 'function' ? call() : call);
    return { stale: !this.current(t), value };
  }
}
