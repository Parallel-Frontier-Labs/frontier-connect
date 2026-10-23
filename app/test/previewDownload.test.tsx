import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DownloadOutcome, Stale } from '../src/bridge';
import { LINK_FAILED } from '../src/hostBridge';
import type { DownloadApi } from '../src/view/Files';
import { PreviewPane, type PreviewApi } from '../src/view/PreviewPane';

afterEach(cleanup);
const api: PreviewApi = {
  bytes: async () => ({ kind: 'ok' as const, bytes: new TextEncoder().encode('hello') }),
  load: (async () => { throw new Error('viewer unavailable'); }) as unknown as PreviewApi['load'],
};
const pane = (download: DownloadApi) =>
  render(<PreviewPane file={{ path: 'out/notes.txt', name: 'notes.txt' }} api={api} download={download} onClose={() => {}} />);
const click = async () => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download notes.txt' })); });
};

describe('PreviewPane download outcome', () => {
  it('shows Preparing… while the link is made', async () => {
    let finish!: (v: DownloadOutcome | Stale) => void;
    const get = vi.fn(() => new Promise<DownloadOutcome | Stale>((r) => { finish = r; }));
    pane({ enabled: true, get });
    await screen.findByText('hello');
    await click();
    const b = screen.getByRole('button', { name: 'Preparing notes.txt' });
    expect(b.textContent).toContain('Preparing…');
    expect(b.getAttribute('aria-busy')).toBe('true');
    await act(async () => { finish({ kind: 'opened' }); });
    expect(screen.getByRole('button', { name: 'Download notes.txt' }).textContent).toContain('Download');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a failed outcome with its message and a Retry that asks again', async () => {
    const get = vi.fn(async (): Promise<DownloadOutcome | Stale> => ({ kind: 'failed', message: 'The link could not be made.' }));
    pane({ enabled: true, get });
    await screen.findByText('hello');
    await click();
    expect(screen.getByRole('alert').textContent).toContain('The link could not be made.');
    get.mockResolvedValueOnce({ kind: 'opened' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry downloading notes.txt' })); });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith('out/notes.txt');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the link when the host did not open it', async () => {
    const get = vi.fn(async (): Promise<DownloadOutcome | Stale> => ({ kind: 'link', url: 'https://files.example.com/n.txt?sig=1', name: 'notes.txt' }));
    pane({ enabled: true, get });
    await screen.findByText('hello');
    await click();
    expect(screen.getByText('Open this link to download:')).toBeTruthy();
    const a = screen.getByRole('link', { name: 'notes.txt' });
    expect(a.getAttribute('href')).toBe('https://files.example.com/n.txt?sig=1');
  });

  it('shows a get that throws as a failure', async () => {
    const get = vi.fn(async (): Promise<DownloadOutcome | Stale> => { throw new Error('boom'); });
    pane({ enabled: true, get });
    await screen.findByText('hello');
    await click();
    expect(screen.getByRole('alert').textContent).toContain(LINK_FAILED);
    expect(screen.getByRole('button', { name: 'Retry downloading notes.txt' })).toBeTruthy();
  });
});
