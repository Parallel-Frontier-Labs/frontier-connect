import { act, cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bridge } from '../src/bridge';
import { Root } from '../src/Root';
import type { TaskPayload } from '../src/types';

const done = {
  task_id: 't1', status: 'done', title: 'Quarterly review', plan: [], sections: [], live: null,
  estimate: null, open_ask: null, deliverables: [], result: null, work_ms: 0, usage: null,
  events: [], cursor: 1, more: false, view: null,
} as unknown as TaskPayload;

function rig(o: { theme?: 'light' | 'dark'; tool?: string } = {}) {
  let onPayload: (p: TaskPayload) => void = () => {};
  let onReady: () => void = () => {};
  let onErr: (e: unknown) => void = () => {};
  let tool: string | undefined;
  const bridge = {
    onPayload: (cb: (p: TaskPayload) => void) => (onPayload = cb),
    getTask: async () => null,
    theme: () => o.theme ?? 'light',
    toolName: () => tool,
    onThemeChange: () => {},
    onConnectError: (cb: (e: unknown) => void) => (onErr = cb),
    canCallTools: () => false,
    onReady: (cb: () => void) => (onReady = cb),
    answer: async () => ({ kind: 'failed', message: '' }),
    onList: () => {},
  } as unknown as Bridge;
  return {
    bridge,
    payload: (p: TaskPayload) => onPayload(p),
    ready: (name?: string) => { tool = name ?? o.tool; onReady(); },
    fail: () => onErr(new Error('no host')),
  };
}

const skel = (c: Element) => c.querySelector<HTMLElement>('.fc-skel');

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  document.documentElement.classList.remove('fc-reveal', 'fc-sysfont');
});

describe('loading skeleton', () => {
  it('before a result, shows a task-sized skeleton in the theme, announced as loading', () => {
    const r = rig({ theme: 'dark' });
    const { container } = render(<Root makeBridge={() => r.bridge} />);
    const s = skel(container)!;
    expect(s).not.toBeNull();
    expect(s.className).toContain('fc-skel-task');
    expect(s.getAttribute('data-theme')).toBe('dark');
    expect(s.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('Loading the task');
  });

  it('paints its very first frame in the system theme, before the host bridge exists', () => {
    const saved = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q === '(prefers-color-scheme: dark)' })) as unknown as typeof window.matchMedia;
    try {
      const r = rig({ theme: 'dark' });
      let first: string | null | undefined;
      render(<Root makeBridge={() => { first = skel(document.body)?.getAttribute('data-theme'); return r.bridge; }} />);
      expect(first).toBe('dark');
    } finally {
      window.matchMedia = saved;
    }
  });

  it.each([
    ['frontier_list_tasks', 'fc-skel-list'],
    ['frontier_add_files', 'fc-skel-add'],
    ['frontier_start_task', 'fc-skel-task'],
    ['frontier_get_task', 'fc-skel-task'],
  ])('takes the shape of the view %s will show', (tool, cls) => {
    const r = rig();
    const { container } = render(<Root makeBridge={() => r.bridge} />);
    act(() => r.ready(tool));
    expect(skel(container)!.className).toContain(cls);
  });

  it('stays up until the fonts are in, then swaps to the card once', async () => {
    const r = rig();
    let fontsIn!: () => void;
    const fonts = new Promise<'loaded' | 'timeout'>((res) => (fontsIn = () => res('loaded')));
    const { container } = render(<Root makeBridge={() => r.bridge} fonts={fonts} />);
    act(() => r.payload(done));
    expect(skel(container)).not.toBeNull();
    expect(screen.queryByText('Quarterly review')).toBeNull();
    await act(async () => { fontsIn(); await fonts; });
    expect(skel(container)).toBeNull();
    expect(screen.getByText('Quarterly review')).toBeTruthy();
    // No fade: an animation started after the card painted would blank it for a moment.
    expect(document.documentElement.classList.contains('fc-reveal')).toBe(false);
    expect(document.documentElement.classList.contains('fc-sysfont')).toBe(false);
  });

  it('when the fonts miss the cap, the card shows in system fonts and keeps them (no late re-wrap)', async () => {
    const r = rig();
    const fonts = Promise.resolve('timeout' as const);
    render(<Root makeBridge={() => r.bridge} fonts={fonts} />);
    act(() => r.payload(done));
    await act(async () => { await fonts; });
    expect(screen.getByText('Quarterly review')).toBeTruthy();
    expect(document.documentElement.classList.contains('fc-sysfont')).toBe(true);
  });

  it('with the fonts already in, the card shows as soon as the result arrives', () => {
    const r = rig();
    const { container } = render(<Root makeBridge={() => r.bridge} fonts={null} />);
    act(() => r.payload(done));
    expect(skel(container)).toBeNull();
    expect(screen.getByText('Quarterly review')).toBeTruthy();
  });

  it('a connect error replaces the skeleton without waiting for the fonts', () => {
    const r = rig();
    const { container } = render(<Root makeBridge={() => r.bridge} fonts={new Promise(() => {})} />);
    act(() => r.fail());
    expect(skel(container)).toBeNull();
    expect(screen.getByText("Couldn't connect to the chat app. Reload the conversation.")).toBeTruthy();
  });
});
