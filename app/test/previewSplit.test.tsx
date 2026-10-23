import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Card, DISPLAY_MODE_WAIT_MS } from '../src/view/Card';
import { NO_PREVIEW, type PreviewGate } from '../src/view/PreviewPane';
import type { TaskPayload } from '../src/types';

afterEach(cleanup);
const done = {
  task_id: 't1', status: 'done', title: 'Rebalance', plan: [], sections: [], live: null, estimate: null, open_ask: null,
  deliverables: [{ name: 'model.xlsx', path: 'out/model.xlsx' }, { name: 'notes.txt', path: 'out/notes.txt' }],
  result: { summary: 'Done.' }, work_ms: 0, usage: null, events: [], cursor: 1, more: false, view: null,
} as unknown as TaskPayload;
const dl = { enabled: true, get: vi.fn(async () => ({ kind: 'opened' as const })) };
function gate(over: Partial<PreviewGate> = {}): PreviewGate & { setMode(m: string): void } {
  const g: any = {
    enabled: true, mode: 'inline',
    open: vi.fn(async () => { g.mode = 'fullscreen'; return true; }),
    close: vi.fn(async () => { g.mode = 'inline'; }),
    api: { bytes: vi.fn(async () => ({ kind: 'ok', bytes: new TextEncoder().encode('note body') })), load: vi.fn(async () => { throw new Error('x'); }) },
    ...over,
  };
  g.setMode = (m: string) => { g.mode = m; };
  return g;
}

describe('preview split', () => {
  it('opens a clicked file full screen beside the task, and closes back to inline', async () => {
    const g = gate();
    const r = render(<Card payload={done} download={dl} preview={g} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^notes\.txt$/ })); });
    expect(g.open).toHaveBeenCalled();
    r.rerender(<Card payload={done} download={dl} preview={{ ...g }} />);
    expect(await screen.findByText('note body')).toBeTruthy();
    expect(document.querySelector('.fc-split-main')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close preview' })); });
    expect(g.close).toHaveBeenCalled();
    expect(screen.queryByText('note body')).toBeNull();
    // Focus returns to the row of the file that was open.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^notes\.txt$/ }));
  });

  it('downloads instead when Claude refuses full screen', async () => {
    const g = gate({ open: vi.fn(async () => false) });
    render(<Card payload={done} download={dl} preview={g} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^notes\.txt$/ })); });
    expect(dl.get).toHaveBeenCalledWith('out/notes.txt');
    expect(screen.queryByRole('region', { name: /Preview of/ })).toBeNull();
  });

  it('closes the preview when the host leaves full screen on its own', async () => {
    const g = gate();
    const r = render(<Card payload={done} download={dl} preview={g} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^notes\.txt$/ })); });
    r.rerender(<Card payload={done} download={dl} preview={{ ...g }} />);
    expect(await screen.findByText('note body')).toBeTruthy();
    r.rerender(<Card payload={done} download={dl} preview={{ ...g, mode: 'inline' }} />);
    await waitFor(() => expect(screen.queryByText('note body')).toBeNull());
  });

  it('changes nothing when the preview is off (other hosts)', async () => {
    const get = vi.fn(async () => ({ kind: 'opened' as const }));
    const r = render(<Card payload={done} download={{ enabled: true, get }} preview={NO_PREVIEW} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^notes\.txt$/ })); });
    expect(screen.queryByRole('region', { name: /Preview of/ })).toBeNull();
    expect(document.querySelector('.fc-split')).toBeNull();
    expect(get).not.toHaveBeenCalled();
    // A gate that is off never asks the host for full screen.
    const g = gate({ enabled: false });
    r.rerender(<Card payload={done} download={{ enabled: true, get }} preview={g} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^notes\.txt$/ })); });
    expect(g.open).not.toHaveBeenCalled();
    expect(document.querySelector('.fc-split')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('downloads when the host never answers the full-screen request', async () => {
    vi.useFakeTimers();
    try {
      const get = vi.fn(async () => ({ kind: 'opened' as const }));
      const g = gate({ open: vi.fn(() => new Promise<boolean>(() => {})) });
      render(<Card payload={done} download={{ enabled: true, get }} preview={g} />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^notes\.txt$/ })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(DISPLAY_MODE_WAIT_MS - 10); });
      expect(get).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(get).toHaveBeenCalledWith('out/notes.txt');
      expect(document.querySelector('.fc-split')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets only the latest row click open the preview', async () => {
    let first!: (v: boolean) => void;
    const g = gate();
    let n = 0;
    g.open = vi.fn(() => {
      n += 1;
      if (n === 1) return new Promise<boolean>((res) => { first = res; });
      g.mode = 'fullscreen';
      return Promise.resolve(true);
    });
    const r = render(<Card payload={done} download={dl} preview={g} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^model\.xlsx$/ })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^notes\.txt$/ })); });
    await act(async () => { first(true); });
    r.rerender(<Card payload={done} download={dl} preview={{ ...g }} />);
    expect(screen.getByRole('region', { name: 'Preview of notes.txt' })).toBeTruthy();
  });

  it('keeps the card body mounted, with its state, across opening and closing', async () => {
    const nested = { ...done, deliverables: [{ name: 'a.txt', path: 'out/a/a.txt' }, { name: 'notes.txt', path: 'out/b/notes.txt' }] } as unknown as TaskPayload;
    const g = gate();
    const r = render(<Card payload={nested} download={dl} preview={g} />);
    const folder = () => screen.getByRole('button', { name: /^a\// });
    fireEvent.click(folder());
    expect(folder().getAttribute('aria-expanded')).toBe('false');
    const files = document.querySelector('.fc-files');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^notes\.txt$/ })); });
    r.rerender(<Card payload={nested} download={dl} preview={{ ...g }} />);
    expect(await screen.findByText('note body')).toBeTruthy();
    expect(document.querySelector('.fc-files')).toBe(files);
    expect(folder().getAttribute('aria-expanded')).toBe('false');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close preview' })); });
    r.rerender(<Card payload={nested} download={dl} preview={{ ...g }} />);
    expect(document.querySelector('.fc-files')).toBe(files);
    expect(folder().getAttribute('aria-expanded')).toBe('false');
  });

  it('narrow: hides the task without unmounting it, and Back to the task returns focus to the row', async () => {
    const mm = vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
    vi.stubGlobal('matchMedia', mm);
    try {
      const g = gate();
      const r = render(<Card payload={done} download={dl} preview={g} />);
      const files = document.querySelector('.fc-files');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^notes\.txt$/ })); });
      r.rerender(<Card payload={done} download={dl} preview={{ ...g }} />);
      expect(await screen.findByText('note body')).toBeTruthy();
      expect(document.querySelector('.fc-files')).toBe(files);
      expect((document.querySelector('.fc-split-main') as HTMLElement).hidden).toBe(true);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Back to the task' })); });
      expect(g.close).not.toHaveBeenCalled();
      expect(document.querySelector('.fc-files')).toBe(files);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /^notes\.txt$/ }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
