import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@modelcontextprotocol/ext-apps';
import type { Bridge, LinkOutcome } from '../src/bridge';
import { Generations } from '../src/generation';
import { createHostBridge, LINK_FAILED } from '../src/hostBridge';
import { OPEN_LINK_WAIT_MS, Root } from '../src/Root';
import { parsePayload, type TaskPayload } from '../src/types';

afterEach(cleanup);
const tick = () => new Promise((r) => setTimeout(r, 0));
const URL1 = 'https://files.example.com/x.zip?sig=1';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const done = (id = 't1') =>
  ({ task_id: id, status: 'done', title: `Review ${id}`, plan: [], sections: [], live: null, estimate: null, open_ask: null,
    deliverables: [{ name: 'summary.md', path: 'Review/summary.md' }, { name: 'q1.xlsx', path: 'Review/data/q1.xlsx' }],
    result: null, work_ms: 0, usage: null, events: [], cursor: 1, more: false, view: null }) as unknown as TaskPayload;

/** A host bridge whose file links resolve when the test says so. */
function rig(tools = true, opens = true, openImpl?: (url: string) => Promise<boolean>) {
  let onPayload: (p: TaskPayload) => void = () => {};
  let onReady: () => void = () => {};
  const links: { path: string | null; d: ReturnType<typeof deferred<LinkOutcome>> }[] = [];
  const bridge = {
    onPayload: (cb: (p: TaskPayload) => void) => (onPayload = cb),
    getTask: async () => null,
    theme: () => 'light' as const,
    onThemeChange: () => {},
    onConnectError: () => {},
    canCallTools: () => tools,
    onReady: (cb: () => void) => (onReady = cb),
    answer: async () => ({ kind: 'failed' as const, message: '' }),
    onList: () => {},
    listTasks: async () => ({ kind: 'failed' as const, message: '' }),
    deleteTask: async () => ({ kind: 'failed' as const, message: '' }),
    fileLink: vi.fn((_t: string, path: string | null) => {
      const d = deferred<LinkOutcome>();
      links.push({ path, d });
      return d.promise;
    }),
    openLink: vi.fn(openImpl ?? (async () => opens)),
  };
  render(<Root makeBridge={() => bridge as unknown as Bridge} />);
  act(() => onPayload(done()));
  act(() => onReady());
  return { bridge, links, payload: (p: TaskPayload) => act(() => onPayload(p)) };
}

const ok = (name = 'Review t1.zip'): LinkOutcome => ({ kind: 'ok', url: URL1, name });

describe('download buttons', () => {
  it('the folder button shows Preparing… while the link is made, then has the host open it', async () => {
    const r = rig();
    const btn = screen.getByRole('button', { name: 'Download folder (.zip)' });
    fireEvent.click(btn);
    expect(r.bridge.fileLink).toHaveBeenCalledWith('t1', null);
    expect(btn.textContent).toContain('Preparing…');
    expect(btn.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(btn); // a second click while preparing does nothing
    expect(r.bridge.fileLink).toHaveBeenCalledTimes(1);
    await act(async () => { r.links[0]!.d.resolve(ok()); await tick(); });
    expect(r.bridge.openLink).toHaveBeenCalledWith(URL1);
    expect(btn.textContent).toContain('Download folder (.zip)');
    expect(btn.getAttribute('aria-busy')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('each file has its own labelled download button that asks for its card path', async () => {
    const r = rig();
    fireEvent.click(screen.getByRole('button', { name: 'Download q1.xlsx' }));
    expect(r.bridge.fileLink).toHaveBeenCalledWith('t1', 'Review/data/q1.xlsx');
    const busy = screen.getByRole('button', { name: 'Preparing q1.xlsx' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    screen.getByRole('button', { name: 'Download summary.md' }); // the other row stays idle
    await act(async () => { r.links[0]!.d.resolve(ok('q1.xlsx')); await tick(); });
    expect(r.bridge.openLink).toHaveBeenCalledWith(URL1);
    screen.getByRole('button', { name: 'Download q1.xlsx' });
  });

  it('a failure shows its line with Retry, and Retry asks again', async () => {
    const r = rig();
    fireEvent.click(screen.getByRole('button', { name: 'Download folder (.zip)' }));
    const msg = 'These files are too large to zip here; open Frontier or use the plugin.';
    await act(async () => { r.links[0]!.d.resolve({ kind: 'failed', message: msg }); await tick(); });
    expect(screen.getByRole('alert').textContent).toContain(msg);
    expect(r.bridge.openLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry downloading the folder' }));
    expect(r.bridge.fileLink).toHaveBeenLastCalledWith('t1', null);
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { r.links[1]!.d.resolve(ok()); await tick(); });
    expect(r.bridge.openLink).toHaveBeenCalledWith(URL1);
  });

  it('when the host cannot open links, the card shows the link itself', async () => {
    const r = rig(true, false);
    fireEvent.click(screen.getByRole('button', { name: 'Download summary.md' }));
    await act(async () => { r.links[0]!.d.resolve(ok('summary.md')); await tick(); });
    const a = screen.getByRole('link', { name: 'summary.md' });
    expect(a.getAttribute('href')).toBe(URL1);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('a link that arrives after the card moved on is dropped and never opened', async () => {
    const r = rig();
    fireEvent.click(screen.getByRole('button', { name: 'Download folder (.zip)' }));
    r.payload(done('t2')); // the host shows another task meanwhile
    await act(async () => { r.links[0]!.d.resolve(ok()); await tick(); });
    expect(r.bridge.openLink).not.toHaveBeenCalled();
    expect(screen.queryByRole('link')).toBeNull();
    screen.getByText('Review t2');
  });

  it('a host update for the same task does not drop the link', async () => {
    const r = rig();
    fireEvent.click(screen.getByRole('button', { name: 'Download folder (.zip)' }));
    r.payload(done('t1')); // the model re-read the task meanwhile
    await act(async () => { r.links[0]!.d.resolve(ok()); await tick(); });
    expect(r.bridge.openLink).toHaveBeenCalledWith(URL1);
  });

  it('a same-task update before a host without links still shows the link', async () => {
    const r = rig(true, false);
    fireEvent.click(screen.getByRole('button', { name: 'Download summary.md' }));
    r.payload(done('t1'));
    await act(async () => { r.links[0]!.d.resolve(ok('summary.md')); await tick(); });
    expect(screen.getByRole('link', { name: 'summary.md' }).getAttribute('href')).toBe(URL1);
  });

  it('a host that never answers the open request gets the plain link after the wait', async () => {
    vi.useFakeTimers();
    try {
      const r = rig(true, true, () => new Promise<boolean>(() => {}));
      const btn = screen.getByRole('button', { name: 'Download folder (.zip)' });
      fireEvent.click(btn);
      await act(async () => { r.links[0]!.d.resolve(ok()); await vi.advanceTimersByTimeAsync(0); });
      expect(btn.textContent).toContain('Preparing…');
      await act(async () => { await vi.advanceTimersByTimeAsync(OPEN_LINK_WAIT_MS - 10); });
      expect(screen.queryByRole('link')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(screen.getByRole('link', { name: 'Review t1.zip' }).getAttribute('href')).toBe(URL1);
      expect(btn.textContent).toContain('Download folder (.zip)');
      expect(OPEN_LINK_WAIT_MS).toBe(5000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a host that rejects the open request gets the plain link', async () => {
    const r = rig(true, true, async () => { throw new Error('lost'); });
    fireEvent.click(screen.getByRole('button', { name: 'Download summary.md' }));
    await act(async () => { r.links[0]!.d.resolve(ok('summary.md')); await tick(); });
    expect(screen.getByRole('link', { name: 'summary.md' }).getAttribute('href')).toBe(URL1);
  });

  it('the calls go through the one guard', async () => {
    const run = vi.spyOn(Generations.prototype, 'run');
    const r = rig();
    run.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Download summary.md' }));
    await act(async () => { r.links[0]!.d.resolve(ok('summary.md')); await tick(); });
    expect(run).toHaveBeenCalledTimes(2); // the link, then opening it
    run.mockRestore();
  });

  it('without app tool calls there are no buttons, only the hint', () => {
    rig(false);
    expect(screen.queryByRole('button', { name: 'Download folder (.zip)' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Download / })).toBeNull();
    screen.getByText('Open in Frontier to download');
  });
});

function fakeApp(over: Record<string, unknown> = {}) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    callServerTool: vi.fn(),
    getHostContext: vi.fn(() => ({})),
    getHostCapabilities: vi.fn(() => ({ serverTools: {}, openLinks: {} })),
    openLink: vi.fn().mockResolvedValue({}),
    ...over,
  } as unknown as App & { callServerTool: ReturnType<typeof vi.fn>; openLink: ReturnType<typeof vi.fn> };
}

const saved = (id = 't1', dir = 'Review t1') =>
  ({ ...done(id), saved: { dir, at: '2026-10-19T17:00:00+00:00' } }) as unknown as TaskPayload;

describe('saved to your folder', () => {
  it('without `saved` the box is unchanged: the workspace line and the zip button', () => {
    rig();
    screen.getByText("In this task's workspace");
    screen.getByRole('button', { name: 'Download folder (.zip)' });
    expect(screen.queryByText(/Saved to your folder/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download again (.zip)' })).toBeNull();
  });

  it('with `saved` the main line names the folder and the zip becomes a small Download again link', async () => {
    const r = rig();
    r.payload(saved());
    const title = screen.getByText(/Saved to your folder ·/);
    expect(title.textContent).toBe('Saved to your folder · Review t1');
    expect(title.closest('.fc-loc')?.querySelector('.fc-loc-icon svg')).not.toBeNull();
    expect(screen.queryByText("In this task's workspace")).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download folder (.zip)' })).toBeNull();
    const again = screen.getByRole('button', { name: 'Download again (.zip)' });
    expect(again.classList.contains('fc-toggle')).toBe(true);
    expect(again.classList.contains('fc-secondary')).toBe(false);
    // Per-file download icons stay.
    screen.getByRole('button', { name: 'Download summary.md' });
    screen.getByRole('button', { name: 'Download q1.xlsx' });
    fireEvent.click(again);
    expect(r.bridge.fileLink).toHaveBeenCalledWith('t1', null);
    expect(again.textContent).toBe('Preparing…');
    await act(async () => { r.links[0]!.d.resolve(ok()); await tick(); });
    expect(r.bridge.openLink).toHaveBeenCalledWith(URL1);
    expect(again.textContent).toBe('Download again (.zip)');
  });

  it('with `saved` and no tool calls, the box says saved and offers no download hint', () => {
    const r = rig(false);
    r.payload(saved());
    expect(screen.getByText(/Saved to your folder ·/).textContent).toBe('Saved to your folder · Review t1');
    expect(screen.queryByText('Open in Frontier to download')).toBeNull();
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
  });

  it('parsePayload keeps a folder name and time, and drops anything else', () => {
    const base = { ...done(), saved: undefined } as Record<string, unknown>;
    expect(parsePayload({ ...base, saved: { dir: 'Q3 report', at: '2026-10-19T17:00:00Z' } })?.saved)
      .toEqual({ dir: 'Q3 report', at: '2026-10-19T17:00:00Z' });
    expect(parsePayload(base)?.saved).toBeNull();
    for (const bad of [null, 'x', { dir: '' }, { dir: 'a/b', at: 'x' }, { dir: 'C:\\a', at: 'x' }, { dir: 'ok' }, { dir: 7, at: 'x' }])
      expect(parsePayload({ ...base, saved: bad })?.saved).toBeNull();
    expect(parsePayload({ ...base, saved: { dir: 'x'.repeat(200), at: 'x' } })?.saved?.dir).toHaveLength(80);
  });
});

describe('host bridge file links', () => {
  it('calls frontier_file_link with the path, or without one for the folder', async () => {
    const app = fakeApp();
    app.callServerTool.mockResolvedValue({ structuredContent: { url: URL1, name: 'a.md' } });
    const b = createHostBridge(app);
    expect(await b.fileLink('t1', 'Review/a.md')).toEqual({ kind: 'ok', url: URL1, name: 'a.md' });
    expect(app.callServerTool).toHaveBeenLastCalledWith({ name: 'frontier_file_link', arguments: { task_id: 't1', path: 'Review/a.md' } });
    await b.fileLink('t1', null);
    expect(app.callServerTool).toHaveBeenLastCalledWith({ name: 'frontier_file_link', arguments: { task_id: 't1' } });
  });

  it("relays the server's one-line error, and refuses anything but an https link", async () => {
    const app = fakeApp();
    const b = createHostBridge(app);
    app.callServerTool.mockResolvedValueOnce({ isError: true, structuredContent: { error: { code: 'download_too_large', message: 'Too large.' } } });
    expect(await b.fileLink('t1', null)).toEqual({ kind: 'failed', message: 'Too large.' });
    for (const url of ['javascript:alert(1)', 'http://x.example/a', 'data:text/html,x', 42]) {
      app.callServerTool.mockResolvedValueOnce({ structuredContent: { url, name: 'a' } });
      expect(await b.fileLink('t1', null)).toEqual({ kind: 'failed', message: LINK_FAILED });
    }
    app.callServerTool.mockRejectedValueOnce(new Error('timeout'));
    expect(await b.fileLink('t1', null)).toEqual({ kind: 'failed', message: LINK_FAILED });
  });

  it('opens links through the host only when it offers them', async () => {
    const app = fakeApp();
    const b = createHostBridge(app);
    expect(await b.openLink(URL1)).toBe(true);
    expect(app.openLink).toHaveBeenCalledWith({ url: URL1 });
    app.openLink.mockResolvedValueOnce({ isError: true });
    expect(await b.openLink(URL1)).toBe(false);
    app.openLink.mockRejectedValueOnce(new Error('lost'));
    expect(await b.openLink(URL1)).toBe(false);
    const none = fakeApp({ getHostCapabilities: vi.fn(() => ({ serverTools: {} })) });
    expect(await createHostBridge(none).openLink(URL1)).toBe(false);
    expect(none.openLink).not.toHaveBeenCalled();
  });
});
