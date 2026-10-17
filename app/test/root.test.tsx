import { act, cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bridge } from '../src/bridge';
import { Root } from '../src/Root';
import type { TaskPayload } from '../src/types';

function rig(theme: 'light' | 'dark' = 'light') {
  let onPayload: (p: TaskPayload) => void = () => {};
  let onTheme: (t: 'light' | 'dark') => void = () => {};
  let onErr: (e: unknown) => void = () => {};
  let cur = theme;
  const bridge: Bridge = {
    onPayload: (cb) => (onPayload = cb),
    getTask: async () => null,
    theme: () => cur,
    onThemeChange: (cb) => (onTheme = cb),
    onConnectError: (cb) => (onErr = cb),
  };
  return {
    bridge,
    payload: (p: TaskPayload) => onPayload(p),
    theme: (t: 'light' | 'dark') => ((cur = t), onTheme(t)),
    fail: (e: unknown) => onErr(e),
  };
}

const done = {
  task_id: 't1', status: 'done', title: 'Quarterly review', plan: [], sections: [], live: null,
  estimate: null, open_ask: null, deliverables: [], result: null, work_ms: 0, usage: null,
  events: [], cursor: 1, more: false, view: null,
} as unknown as TaskPayload;

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

describe('Root', () => {
  it('updates data-theme when the host theme changes', () => {
    const r = rig('light');
    render(<Root makeBridge={() => r.bridge} />);
    expect(document.documentElement.dataset.theme).toBe('light');
    act(() => r.theme('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('shows a connect error instead of loading forever', () => {
    const r = rig();
    render(<Root makeBridge={() => r.bridge} />);
    expect(screen.getByText(/Loading the task/)).toBeTruthy();
    act(() => r.fail(new Error('no host')));
    expect(screen.getByText("Couldn't connect to the chat app. Reload the conversation.")).toBeTruthy();
    expect(screen.queryByText(/Loading the task/)).toBeNull();
  });

  it('keeps showing the card if a payload arrived before the error', () => {
    const r = rig();
    render(<Root makeBridge={() => r.bridge} />);
    act(() => r.payload(done));
    act(() => r.fail(new Error('late')));
    expect(screen.getByText('Quarterly review')).toBeTruthy();
  });
});
