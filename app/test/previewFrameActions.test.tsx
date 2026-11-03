import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LINK_CONFIRM, LINK_CONFIRM_ARM_MS, notFoundLine, PAGE_DOWNLOAD_UNAVAILABLE, PreviewPane, type PreviewApi } from '../src/view/PreviewPane';

afterEach(cleanup);
const page = '<!doctype html><p>dash</p>';
const files = [
  { name: 'Report_2026-10.html', path: 'runs/2026-10/Report_2026-10.html' },
  { name: 'Book_2026-10.xlsx', path: 'runs/2026-10/Book_2026-10.xlsx' },
];
const api = (over: Partial<PreviewApi> = {}): PreviewApi => ({
  bytes: vi.fn(async () => ({ kind: 'ok' as const, bytes: new TextEncoder().encode(page) })),
  load: vi.fn() as unknown as PreviewApi['load'],
  openLink: vi.fn(async () => true),
  saveBytes: vi.fn(async () => true),
  ...over,
});
const dl = () => ({ enabled: true, get: vi.fn(async () => ({ kind: 'opened' as const })) });

async function mount(a = api(), d = dl()) {
  const r = render(<PreviewPane file={files[0]!} files={files} api={a} download={d} onClose={() => {}} />);
  const frame = (await vi.waitFor(() => { const f = r.container.querySelector('iframe'); if (!f) throw new Error('no frame'); return f; }));
  const send = (data: unknown, source: unknown = frame.contentWindow) =>
    act(async () => { window.dispatchEvent(new MessageEvent('message', { data, source: source as Window })); await Promise.resolve(); });
  return { a, d, send };
}
const msg = (o: object) => ({ type: 'frontier:frame', v: 1, ...o });
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const openButton = () => screen.getByRole('button', { name: 'Open link' }) as HTMLButtonElement;

describe('PreviewPane frame actions', () => {
  it('downloads the matched sibling deliverable for a relative link', async () => {
    const { d, send } = await mount();
    await send(msg({ kind: 'file', href: 'Book_2026-10.xlsx' }));
    expect(d.get).toHaveBeenCalledWith('runs/2026-10/Book_2026-10.xlsx');
  });

  it('says so when the link names no delivered file', async () => {
    const { d, send } = await mount();
    await send(msg({ kind: 'file', href: 'Missing%20Book.xlsx' }));
    expect(d.get).not.toHaveBeenCalled();
    expect(await screen.findByText(notFoundLine('Missing Book.xlsx'))).toBeTruthy();
  });

  it('saves page-built bytes through the host, with a safe name', async () => {
    const { a, send } = await mount();
    await send(msg({ kind: 'download', name: '../x/list.csv', mime: 'text/csv', base64: 'YSxi' }));
    expect(a.saveBytes).toHaveBeenCalledWith('list.csv', 'text/csv', 'YSxi');
  });

  it('says the download is unavailable when the host cannot save, or the file was too large', async () => {
    const { send } = await mount(api({ saveBytes: vi.fn(async () => false) }));
    await send(msg({ kind: 'download', name: 'a.csv', mime: 'text/csv', base64: 'YSxi' }));
    expect(await screen.findByText(PAGE_DOWNLOAD_UNAVAILABLE)).toBeTruthy();
    cleanup();
    const second = await mount();
    await second.send(msg({ kind: 'download', name: 'big.bin', mime: '', base64: '' }));
    expect(second.a.saveBytes).not.toHaveBeenCalled();
    expect(await screen.findByText(PAGE_DOWNLOAD_UNAVAILABLE)).toBeTruthy();
  });

  it('never opens a link from the message alone: it shows the address with a card button', async () => {
    const { a, send } = await mount();
    await send(msg({ kind: 'link', href: 'https://example.com/source?q=1' }));
    expect(a.openLink).not.toHaveBeenCalled();
    const note = (await screen.findByText(LINK_CONFIRM)).closest('p')!;
    expect(note.querySelector('code.fc-pv-url')!.textContent).toBe('https://example.com/source?q=1');
    expect(screen.getByRole('button', { name: 'Open link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('opens the link from the Open link button, and shows the link when the host cannot', async () => {
    const { a, send } = await mount(api({ openLink: vi.fn(async () => false) }));
    await send(msg({ kind: 'link', href: 'https://example.com/source' }));
    await wait(LINK_CONFIRM_ARM_MS + 50);
    await act(async () => { fireEvent.click(openButton()); });
    expect(a.openLink).toHaveBeenCalledWith('https://example.com/source');
    const link = await screen.findByRole('link', { name: 'https://example.com/source' });
    expect(link.getAttribute('href')).toBe('https://example.com/source');
    expect(screen.queryByText(LINK_CONFIRM)).toBeNull();
  });

  it('Cancel clears the confirmation without opening anything', async () => {
    const { a, send } = await mount();
    await send(msg({ kind: 'link', href: 'https://example.com/source' }));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Cancel' })); });
    expect(screen.queryByText(LINK_CONFIRM)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open link' })).toBeNull();
    expect(a.openLink).not.toHaveBeenCalled();
  });

  it('a second link message replaces the pending address', async () => {
    const { a, send } = await mount();
    await send(msg({ kind: 'link', href: 'https://example.com/1' }));
    await send(msg({ kind: 'link', href: 'https://example.com/2' }));
    const urls = Array.from(document.querySelectorAll('code.fc-pv-url')).map((c) => c.textContent);
    expect(urls).toEqual(['https://example.com/2']);
    await wait(LINK_CONFIRM_ARM_MS + 50);
    await act(async () => { fireEvent.click(openButton()); });
    expect(a.openLink).toHaveBeenCalledTimes(1);
    expect(a.openLink).toHaveBeenCalledWith('https://example.com/2');
  });

  it('arms Open link only after the address has been shown for a moment', async () => {
    expect(LINK_CONFIRM_ARM_MS).toBe(750);
    const { a, send } = await mount();
    await send(msg({ kind: 'link', href: 'https://example.com/1' }));
    expect(openButton().disabled).toBe(true);
    await act(async () => { fireEvent.click(openButton()); });
    expect(a.openLink).not.toHaveBeenCalled();
    await wait(LINK_CONFIRM_ARM_MS + 50);
    expect(openButton().disabled).toBe(false);
  });

  it('a replacement address disarms Open link again', async () => {
    const { a, send } = await mount();
    await send(msg({ kind: 'link', href: 'https://example.com/1' }));
    await wait(LINK_CONFIRM_ARM_MS + 50);
    expect(openButton().disabled).toBe(false);
    await send(msg({ kind: 'link', href: 'https://example.com/2' }));
    expect(openButton().disabled).toBe(true);
    await act(async () => { fireEvent.click(openButton()); });
    expect(a.openLink).not.toHaveBeenCalled();
    await wait(LINK_CONFIRM_ARM_MS + 50);
    expect(openButton().disabled).toBe(false);
  });

  it('ignores messages from any other window and malformed ones', async () => {
    const { a, d, send } = await mount();
    await send(msg({ kind: 'file', href: 'Book_2026-10.xlsx' }), window);
    await send(msg({ kind: 'link', href: 'javascript:alert(1)' }));
    await send({ type: 'frontier:frame', v: 2, kind: 'file', href: 'Book_2026-10.xlsx' });
    expect(d.get).not.toHaveBeenCalled();
    expect(a.openLink).not.toHaveBeenCalled();
  });

  it('ignores a message when the browser reports no user activation', async () => {
    const { d, send } = await mount();
    Object.defineProperty(navigator, 'userActivation', { value: { isActive: false }, configurable: true });
    try {
      await send(msg({ kind: 'file', href: 'Book_2026-10.xlsx' }));
      expect(d.get).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, 'userActivation', { value: undefined, configurable: true });
    }
  });

  it('runs one action at a time', async () => {
    let release!: () => void;
    const slow = api({ saveBytes: vi.fn(() => new Promise<boolean>((r) => { release = () => r(true); })) });
    const { send } = await mount(slow);
    const dlMsg = (n: number) => msg({ kind: 'download', name: `f${n}.csv`, mime: 'text/csv', base64: 'YSxi' });
    await send(dlMsg(1));
    await send(dlMsg(2));
    expect(slow.saveBytes).toHaveBeenCalledTimes(1);
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    await send(dlMsg(3));
    expect(slow.saveBytes).toHaveBeenCalledTimes(2);
  });
});
