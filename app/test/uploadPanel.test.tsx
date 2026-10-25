import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UploadApi } from '../src/view/UploadPanel';
import { readyText, UploadPanel } from '../src/view/UploadPanel';
import { AddFiles } from '../src/view/AddFiles';

afterEach(cleanup);
const file = (path: string, size = 3) => {
  const f = new File([new Uint8Array(size)], path.split('/').pop()!);
  Object.defineProperty(f, 'webkitRelativePath', { value: path.includes('/') ? path : '' });
  return f;
};
const pick = (input: HTMLInputElement, files: File[]) => {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
};
const api = (over: Partial<UploadApi> = {}): UploadApi => ({
  enabled: true,
  send: vi.fn(async (_t: string, files: { path: string }[]) => ({ sent: files.map((f: { path: string }) => f.path), failed: [], error: null })),
  tell: vi.fn(async () => true),
  ...over,
});

describe('UploadPanel', () => {
  it('offers a folder and files picker, lists what will be sent, and skips hidden files', () => {
    render(<UploadPanel taskId="t1" api={api()} onSent={() => {}} />);
    const folder = document.querySelector<HTMLInputElement>('input[webkitdirectory]')!;
    expect(screen.getByRole('button', { name: 'Add folder' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add files' })).toBeTruthy();
    pick(folder, [file('test/a.pdf'), file('test/.DS_Store'), file('test/b.csv')]);
    expect(screen.getByText('2 files · 6 B')).toBeTruthy();
    expect(screen.getByText('test/a.pdf')).toBeTruthy();
    expect(screen.queryByText('test/.DS_Store')).toBeNull();
    expect(screen.getByText('1 hidden file skipped')).toBeTruthy();
  });

  it('sends on Send to Frontier and reports back the sent paths', async () => {
    const a = api();
    const onSent = vi.fn();
    render(<UploadPanel taskId="t1" instruction="Map it" api={a} onSent={onSent} />);
    pick(document.querySelector<HTMLInputElement>('input[multiple]:not([webkitdirectory])')!, [file('a.pdf')]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to Frontier' })); });
    expect(a.send).toHaveBeenCalledWith('t1', [expect.objectContaining({ path: 'a.pdf' })], expect.any(Function), 'Map it');
    expect(onSent).toHaveBeenCalledWith(['a.pdf']);
  });

  it('shows failed files with Retry, which resends only those', async () => {
    let first = true;
    const a = api({ send: vi.fn(async (_t: string, files: { path: string }[]) => (first ? ((first = false), { sent: ['a.pdf'], failed: [{ path: 'b.pdf', reason: 'network error' }], error: null })
      : { sent: files.map((f: { path: string }) => f.path), failed: [], error: null })) });
    const onSent = vi.fn();
    render(<UploadPanel taskId="t1" api={a} onSent={onSent} />);
    pick(document.querySelector<HTMLInputElement>('input[multiple]:not([webkitdirectory])')!, [file('a.pdf'), file('b.pdf')]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to Frontier' })); });
    expect(screen.getByText(/b\.pdf: network error/)).toBeTruthy();
    expect(onSent).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect((a.send as any).mock.calls[1][1].map((f: any) => f.path)).toEqual(['b.pdf']);
    expect(onSent).toHaveBeenCalledWith(['a.pdf', 'b.pdf']);
  });

  it('shows a refusal before sending (caps), and the transfer error after', async () => {
    const a = api({ send: vi.fn(async () => ({ sent: [], failed: [], error: "Couldn't reach Frontier. Check the connection and try again." })) });
    render(<UploadPanel taskId="t1" api={a} onSent={() => {}} />);
    pick(document.querySelector<HTMLInputElement>('input[multiple]:not([webkitdirectory])')!, [file('a.pdf')]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to Frontier' })); });
    expect(screen.getByRole('alert').textContent).toContain("Couldn't reach Frontier");
  });

  it('accepts single files dropped on it', () => {
    render(<UploadPanel taskId="t1" api={api()} onSent={() => {}} />);
    const zone = screen.getByText(/drop files here/i).closest('div')!;
    fireEvent.drop(zone, { dataTransfer: { files: [file('dropped.pdf')] } });
    expect(screen.getByText('dropped.pdf')).toBeTruthy();
  });

  it('is replaced by a note when the host cannot run the card\'s tools', () => {
    render(<UploadPanel taskId="t1" api={{ ...api(), enabled: false }} onSent={() => {}} />);
    expect(screen.getByText('Attach the files in the chat instead.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add folder' })).toBeNull();
  });
});

describe('UploadPanel fix round 1', () => {
  const failB = (): UploadApi => {
    let first = true;
    return api({ send: vi.fn(async (_t: string, files: { path: string }[]) => (first
      ? ((first = false), { sent: ['a.pdf'], failed: [{ path: 'b.pdf', reason: 'network error' }], error: null })
      : { sent: files.map((f) => f.path), failed: [], error: null })) });
  };
  const input = () => document.querySelector<HTMLInputElement>('input[multiple]:not([webkitdirectory])')!;

  it('two quick Retry clicks send once and report once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const a = api({ send: vi.fn(async (_t: string, files: { path: string }[]) => {
      n++;
      if (n === 1) return { sent: ['a.pdf'], failed: [{ path: 'b.pdf', reason: 'x' }], error: null };
      await gate;
      return { sent: files.map((f) => f.path), failed: [], error: null };
    }) });
    const onSent = vi.fn();
    render(<UploadPanel taskId="t1" api={a} onSent={onSent} />);
    pick(input(), [file('a.pdf'), file('b.pdf')]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to Frontier' })); });
    const retry = screen.getByRole('button', { name: 'Retry' });
    await act(async () => { fireEvent.click(retry); fireEvent.click(retry); });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(); });
    expect(a.send).toHaveBeenCalledTimes(2);
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it('does not re-upload sent files when more are added; onSent is de-duplicated', async () => {
    const a = failB();
    const onSent = vi.fn();
    render(<UploadPanel taskId="t1" api={a} onSent={onSent} />);
    pick(input(), [file('a.pdf'), file('b.pdf')]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to Frontier' })); });
    pick(input(), [file('c.pdf')]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to Frontier' })); });
    expect((a.send as any).mock.calls[1][1].map((f: any) => f.path)).toEqual(['b.pdf', 'c.pdf']);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledWith(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(screen.getAllByText(/Sent/).length).toBeGreaterThan(0);
  });

  it('a send that throws leaves the panel usable, not stuck on progress', async () => {
    const a = api({ send: vi.fn(async () => { throw new Error('boom'); }) });
    render(<UploadPanel taskId="t1" api={a} onSent={() => {}} />);
    pick(input(), [file('a.pdf')]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to Frontier' })); });
    expect(screen.getByText('The upload stopped unexpectedly. Try again.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send to Frontier' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('AddFiles tells the chat once even if onSent fires twice', async () => {
    const a = api();
    render(<AddFiles add={{ view: 'add_files', task_id: 'task-1', instruction: '', existing: false }} api={a} theme="light" embedded />);
    pick(input(), [file('a.pdf')]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to Frontier' })); });
    await waitFor(() => expect(a.tell).toHaveBeenCalledTimes(1));
  });
});

describe('UploadPanel public review fixes', () => {
  const input = () => document.querySelector<HTMLInputElement>('input[multiple]:not([webkitdirectory])')!;
  const sendBtn = () => screen.getByRole('button', { name: 'Send to Frontier' });

  it('ignores a drop and a file-input change while a send is in flight, and marks the zone disabled', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const a = api({ send: vi.fn(async (_t: string, files: { path: string }[]) => { await gate; return { sent: files.map((f) => f.path), failed: [], error: null }; }) });
    const onSent = vi.fn();
    render(<UploadPanel taskId="t1" api={a} onSent={onSent} />);
    pick(input(), [file('a.pdf')]);
    await act(async () => { fireEvent.click(sendBtn()); });
    const zone = screen.getByText(/drop files here/i).closest('div')!;
    expect(zone.getAttribute('aria-disabled')).toBe('true');
    fireEvent.drop(zone, { dataTransfer: { files: [file('late.pdf')] } });
    pick(input(), [file('late2.pdf')]);
    await act(async () => { release(); });
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledWith(['a.pdf']);
    expect(screen.queryByText('late.pdf')).toBeNull();
    expect(screen.queryByText('late2.pdf')).toBeNull();
    await waitFor(() => expect(screen.getByText(/drop files here/i).closest('div')!.getAttribute('aria-disabled')).toBe('false'));
  });

  it('does not call onSent while something is still pending after a run', async () => {
    let n = 0;
    const a = api({ send: vi.fn(async (_t: string, files: { path: string }[]) => {
      n++;
      return { sent: n === 1 ? ['a.pdf'] : files.map((f) => f.path), failed: [], error: null };
    }) });
    const onSent = vi.fn();
    render(<UploadPanel taskId="t1" api={a} onSent={onSent} />);
    pick(input(), [file('a.pdf'), file('b.pdf')]);
    await act(async () => { fireEvent.click(sendBtn()); });
    expect(onSent).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(sendBtn()); });
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledWith(['a.pdf', 'b.pdf']);
  });

  it('Clear recovers from an over-limit selection', async () => {
    const a = api();
    render(<UploadPanel taskId="t1" api={a} onSent={() => {}} />);
    pick(input(), Array.from({ length: 1001 }, (_, i) => file(`f${i}.txt`, 1)));
    expect(screen.getByRole('alert').textContent).toContain('1000');
    expect(screen.queryByRole('button', { name: 'Send to Frontier' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    pick(input(), [file('small.pdf')]);
    await act(async () => { fireEvent.click(sendBtn()); });
    expect((a.send as any).mock.calls[0][1].map((f: any) => f.path)).toEqual(['small.pdf']);
  });

  it('Clear keeps already-sent files out of the next send, and the hand-off lists them once', async () => {
    let n = 0;
    const a = api({ send: vi.fn(async (_t: string, files: { path: string }[]) => {
      n++;
      return n === 1 ? { sent: ['a.pdf'], failed: [{ path: 'b.pdf', reason: 'x' }], error: null } : { sent: files.map((f) => f.path), failed: [], error: null };
    }) });
    const onSent = vi.fn();
    render(<UploadPanel taskId="t1" api={a} onSent={onSent} />);
    pick(input(), [file('a.pdf'), file('b.pdf')]);
    await act(async () => { fireEvent.click(sendBtn()); });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    pick(input(), [file('a.pdf'), file('c.pdf')]);
    await act(async () => { fireEvent.click(sendBtn()); });
    expect((a.send as any).mock.calls[1][1].map((f: any) => f.path)).toEqual(['c.pdf']);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledWith(['a.pdf', 'c.pdf']);
  });
});

describe('readyText', () => {
  it('names the task and what was added', () => {
    expect(readyText('new', 'task-1', ['S/a.pdf', 'S/b.pdf', 'm.xlsx'])).toBe(
      'I added 3 files for Frontier (S/, m.xlsx). upload_id: task-1. Call frontier_start_task with this upload_id (if that tool isn\'t loaded yet, look it up by that exact name); the files are already attached, so don\'t list them.');
    expect(readyText('ask', 'task-1', ['a.pdf'])).toBe(
      'I added the file Frontier asked for (a.pdf) to task task-1. Call frontier_continue_task for task-1 (if that tool isn\'t loaded yet, look it up by that exact name).');
    expect(readyText('more', 'task-1', ['a.pdf', 'b.pdf'])).toBe(
      'I added 2 new files to the Frontier task task-1 (a.pdf, b.pdf). Call frontier_continue_task for task-1 (if that tool isn\'t loaded yet, look it up by that exact name).');
  });
});

describe('AddFiles', () => {
  it('for the chat\'s existing task tells the model to continue, not start', async () => {
    const a = api();
    render(<AddFiles add={{ view: 'add_files', task_id: 'task-1', instruction: '', existing: true }} api={a} theme="light" embedded />);
    pick(document.querySelector<HTMLInputElement>('input[multiple]:not([webkitdirectory])')!, [file('a.pdf')]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to Frontier' })); });
    await waitFor(() => expect(a.tell).toHaveBeenCalledWith(expect.stringContaining('Call frontier_continue_task for task-1')));
    expect((a.tell as any).mock.calls[0][0]).not.toContain('frontier_start_task');
  });

  it('shows the request, uploads, then tells the chat; if the host cannot, says what to tell it', async () => {
    const a = api({ tell: vi.fn(async () => false) });
    render(<AddFiles add={{ view: 'add_files', task_id: 'task-1', instruction: 'Map the IRA', existing: false }} api={a} theme="light" embedded />);
    expect(screen.getByText('Map the IRA')).toBeTruthy();
    pick(document.querySelector<HTMLInputElement>('input[multiple]:not([webkitdirectory])')!, [file('a.pdf')]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to Frontier' })); });
    await waitFor(() => expect(a.tell).toHaveBeenCalled());
    expect(screen.getByRole('status').textContent).toContain('Tell the chat your files are ready');
    expect(screen.getByRole('status').textContent).toContain('task-1');
  });
});
