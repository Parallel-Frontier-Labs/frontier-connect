import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bridge } from '../src/bridge';
import { viewersAvailable } from '../src/preview/loader';
import { Root } from '../src/Root';
import type { TaskPayload } from '../src/types';

const BASE = 'https://api.example.com/v1/connect/static';
const FILES = { sheet: 'viewer-sheet.0123456789ab.js', pdf: 'viewer-pdf.0123456789ab.js', docx: 'viewer-docx.0123456789ab.js' };
const done = {
  task_id: 't1', status: 'done', title: 'Rebalance', plan: [], sections: [], live: null, estimate: null, open_ask: null,
  deliverables: [{ name: 'notes.txt', path: 'out/notes.txt' }],
  result: { summary: 'Done.' }, work_ms: 0, usage: null, events: [], cursor: 1, more: false, view: null,
} as unknown as TaskPayload;

/** A host bridge: its name, the display modes it offers, and whether it forwards the card's tool calls. */
function rig({ name = 'Claude', modes = ['inline', 'fullscreen'], canAnswer = true }: { name?: string; modes?: string[]; canAnswer?: boolean } = {}) {
  let onPayload: (p: TaskPayload) => void = () => {};
  let onReady: () => void = () => {};
  let onMode: (m: string) => void = () => {};
  let mode = 'inline';
  const bridge: Bridge = {
    onPayload: (cb) => (onPayload = cb),
    getTask: async () => null,
    theme: () => 'light',
    onThemeChange: () => {},
    onConnectError: () => {},
    canCallTools: () => canAnswer,
    onReady: (cb) => (onReady = cb),
    answer: async () => ({ kind: 'failed', message: '' }),
    onList: () => {},
    listTasks: async () => ({ kind: 'failed', message: '' }),
    deleteTask: async () => ({ kind: 'failed', message: '' }),
    fileLink: vi.fn(async () => ({ kind: 'failed' as const, message: 'no link' })),
    openLink: async () => false,
    displayModes: () => modes,
    displayMode: () => mode,
    requestDisplayMode: vi.fn(async (m: string) => m),
    onDisplayModeChange: (cb) => (onMode = cb),
    hostInfo: () => ({ host: { name, version: '1' }, platform: 'desktop', displayMode: mode, displayModes: modes }),
  };
  return {
    bridge,
    start() { act(() => { onReady(); onPayload(done); }); },
    setMode(m: string) { act(() => { mode = m; onMode(m); }); },
  };
}

const row = () => screen.getByRole('button', { name: /^notes\.txt$/ });
const click = async () => { await act(async () => { fireEvent.click(row()); await new Promise((r) => setTimeout(r, 0)); }); };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 204, ok: true, json: async () => null })));
  vi.stubGlobal('__VIEWER_FILES__', FILES);
  document.documentElement.dataset.static = BASE;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.dataset.static = '__FRONTIER_STATIC__';
});

describe('Root preview gate', () => {
  it('previews in Claude with full screen offered, tool calls and the viewers available', async () => {
    const r = rig();
    render(<Root makeBridge={() => r.bridge} />);
    r.start();
    await click();
    expect(r.bridge.requestDisplayMode).toHaveBeenCalledWith('fullscreen');
    r.setMode('fullscreen');
    expect(document.querySelector('.fc-split')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Preview of notes.txt' })).toBeTruthy();
  });

  const plain: [string, Parameters<typeof rig>[0], (() => void)?][] = [
    ['another host (ChatGPT)', { name: 'ChatGPT' }],
    ['a name that only looks like Claude', { name: 'claude' }],
    ['a name that only starts with Claude', { name: 'Claude Desktop' }],
    ['no fullscreen offered', { modes: ['inline', 'pip'] }],
    ['the card cannot call tools', { canAnswer: false }],
    ['an unfilled static base', {}, () => { document.documentElement.dataset.static = '__FRONTIER_STATIC__'; }],
  ];
  for (const [label, opts, setup] of plain) {
    it(`a plain click, no preview: ${label}`, async () => {
      setup?.();
      const r = rig(opts);
      render(<Root makeBridge={() => r.bridge} />);
      r.start();
      await click();
      r.setMode('fullscreen');
      expect(r.bridge.requestDisplayMode).not.toHaveBeenCalled();
      expect(document.querySelector('.fc-split')).toBeNull();
      expect(screen.queryByRole('region', { name: /Preview of/ })).toBeNull();
      // The click only selects the row, as before the preview existed: nothing is fetched.
      expect(row().getAttribute('aria-current')).toBe('true');
      expect(r.bridge.fileLink).not.toHaveBeenCalled();
    });
  }
});

describe('viewersAvailable', () => {
  it('needs both the viewer file names and a filled-in https static base', () => {
    expect(viewersAvailable()).toBe(true);
    document.documentElement.dataset.static = '__FRONTIER_STATIC__';
    expect(viewersAvailable()).toBe(false);
    document.documentElement.dataset.static = 'http://api.example.com/v1/connect/static';
    expect(viewersAvailable()).toBe(false);
    delete document.documentElement.dataset.static;
    expect(viewersAvailable()).toBe(false);
    document.documentElement.dataset.static = BASE;
    vi.unstubAllGlobals();
    expect(viewersAvailable()).toBe(false);
  });
});
