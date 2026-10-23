import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewPane, type PreviewApi } from '../src/view/PreviewPane';

afterEach(cleanup);
afterEach(() => { vi.unstubAllGlobals(); });
const dl = { enabled: true, get: vi.fn(async () => ({ kind: 'opened' as const })) };
const enc = (s: string) => new TextEncoder().encode(s);
const api = (over: Partial<PreviewApi> = {}): PreviewApi => ({
  bytes: vi.fn(async () => ({ kind: 'ok' as const, bytes: enc('hello') })),
  load: vi.fn(async () => { throw new Error('viewer unavailable'); }) as unknown as PreviewApi['load'],
  ...over,
});
const pane = (file: { path: string; name: string }, a: PreviewApi) => <PreviewPane file={file} api={a} download={dl} onClose={() => {}} />;

describe('PreviewPane more states', () => {
  it('injects the Word viewer html', async () => {
    const a = api({ load: vi.fn(async () => ({ toHtml: async () => '<p class="x">Memo body</p>' })) as unknown as PreviewApi['load'] });
    const { container } = render(pane({ path: 'm.docx', name: 'm.docx' }, a));
    await waitFor(() => expect(container.querySelector('.fc-pv-doc p.x')?.textContent).toBe('Memo body'));
  });

  it('renders markdown', async () => {
    const a = api({ bytes: vi.fn(async () => ({ kind: 'ok' as const, bytes: enc('# Heading\n\nbody text') })) });
    render(pane({ path: 'r.md', name: 'r.md' }, a));
    expect(await screen.findByText('Heading')).toBeTruthy();
    expect(screen.getByText('body text')).toBeTruthy();
  });

  it('shows a rejecting bytes call as a failure', async () => {
    const a = api({ bytes: vi.fn(async () => { throw new Error('boom'); }) });
    render(pane({ path: 'r.txt', name: 'r.txt' }, a));
    expect(await screen.findByText(/Couldn't open this file here\./)).toBeTruthy();
  });

  it('ignores a late result for a file no longer shown', async () => {
    let release!: (v: { kind: 'ok'; bytes: Uint8Array }) => void;
    const first = new Promise<{ kind: 'ok'; bytes: Uint8Array }>((r) => { release = r; });
    const a = api({ bytes: vi.fn((p: string) => (p === 'a.txt' ? first : Promise.resolve({ kind: 'ok' as const, bytes: enc('second file') }))) });
    const { rerender } = render(pane({ path: 'a.txt', name: 'a.txt' }, a));
    rerender(pane({ path: 'b.txt', name: 'b.txt' }, a));
    expect(await screen.findByText('second file')).toBeTruthy();
    release({ kind: 'ok', bytes: enc('first file') });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('first file')).toBeNull();
    expect(screen.getByText('second file')).toBeTruthy();
  });

  it('shows a note instead of a blank canvas when a page or image cannot be drawn', async () => {
    const a = api({ load: vi.fn(async () => ({ open: async () => ({ pages: 1, render: async () => { throw new Error('x'); } }) })) as unknown as PreviewApi['load'] });
    render(pane({ path: 'x.pdf', name: 'x.pdf' }, a));
    expect(await screen.findByText("Couldn't show this page.")).toBeTruthy();
    cleanup();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('bad'); }));
    render(pane({ path: 'p.png', name: 'p.png' }, api()));
    expect(await screen.findByText("Couldn't show this image.")).toBeTruthy();
  });
});
