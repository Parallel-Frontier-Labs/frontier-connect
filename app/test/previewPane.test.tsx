import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewPane, type PreviewApi } from '../src/view/PreviewPane';

afterEach(cleanup);
const dl = { enabled: true, get: vi.fn(async () => ({ kind: 'opened' as const })) };
const api = (over: Partial<PreviewApi> = {}): PreviewApi => ({
  bytes: vi.fn(async () => ({ kind: 'ok' as const, bytes: new TextEncoder().encode('hello') })),
  load: vi.fn(async () => { throw new Error('viewer unavailable'); }) as unknown as PreviewApi['load'],
  ...over,
});

describe('PreviewPane', () => {
  it('shows text files directly, with Download and Close in the header', async () => {
    const onClose = vi.fn();
    render(<PreviewPane file={{ path: 'out/notes.txt', name: 'notes.txt' }} api={api()} download={dl} onClose={onClose} />);
    expect(await screen.findByText('hello')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download notes.txt' }));
    expect(dl.get).toHaveBeenCalledWith('out/notes.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders a sheet viewer result with tabs and the cut note', async () => {
    const sheets = [{ name: 'Holdings', rows: [['Ticker', 'Value'], ['VTV', '968000']], cutRows: true, cutCols: false }, { name: 'Model', rows: [['Equity']], cutRows: false, cutCols: false }];
    const a = api({ load: vi.fn(async () => ({ parse: () => sheets })) as unknown as PreviewApi['load'] });
    render(<PreviewPane file={{ path: 'm.xlsx', name: 'm.xlsx' }} api={a} download={dl} onClose={() => {}} />);
    expect(await screen.findByText('VTV')).toBeTruthy();
    expect(screen.getByText('Showing the first 2,000 rows and 100 columns.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    expect(await screen.findByText('Equity')).toBeTruthy();
    expect(screen.queryByText('VTV')).toBeNull();
  });

  it('says when a file is too large, has no preview, or failed (with Retry)', async () => {
    const big = api({ bytes: vi.fn(async () => ({ kind: 'too_large' as const })) });
    const r1 = render(<PreviewPane file={{ path: 'a.pdf', name: 'a.pdf' }} api={big} download={dl} onClose={() => {}} />);
    expect(await screen.findByText('This file is too large to preview (over 25 MB).')).toBeTruthy();
    r1.unmount();
    const none = api();
    const r2 = render(<PreviewPane file={{ path: 'deck.pptx', name: 'deck.pptx' }} api={none} download={dl} onClose={() => {}} />);
    expect(await screen.findByText('No preview for this kind of file.')).toBeTruthy();
    expect(none.bytes).not.toHaveBeenCalled();
    r2.unmount();
    let n = 0;
    const flaky = api({ bytes: vi.fn(async () => (n++ ? { kind: 'ok' as const, bytes: new TextEncoder().encode('ok now') } : { kind: 'failed' as const, message: "Couldn't load this file. Try again." })) });
    render(<PreviewPane file={{ path: 'r.txt', name: 'r.txt' }} api={flaky} download={dl} onClose={() => {}} />);
    expect(await screen.findByText("Couldn't load this file. Try again.")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByText('ok now')).toBeTruthy();
  });

  it('shows a viewer that could not load as a failure, not a hang', async () => {
    render(<PreviewPane file={{ path: 'x.pdf', name: 'x.pdf' }} api={api()} download={dl} onClose={() => {}} />);
    expect(await screen.findByText("Couldn't open this file here.")).toBeTruthy();
  });

  it('renders an HTML file in a sandboxed frame with scripts on and nothing else', async () => {
    const page = '<!DOCTYPE html><html><head><title>Dash</title></head><body><script>1</script></body></html>';
    const a = api({ bytes: vi.fn(async () => ({ kind: 'ok' as const, bytes: new TextEncoder().encode(page) })) });
    const { container } = render(<PreviewPane file={{ path: 'out/dash.html', name: 'dash.html' }} api={a} download={dl} onClose={() => {}} />);
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    const f = container.querySelector('iframe')!;
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.getAttribute('title')).toBe('dash.html');
    const doc = f.getAttribute('srcdoc')!;
    expect(doc.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(doc).toContain("default-src 'none'");
    expect(doc.endsWith(page.slice('<!DOCTYPE html>'.length))).toBe(true);
    expect(a.load).not.toHaveBeenCalled();
  });

  it('renders the first 3 PDF pages, then 5 more on request', async () => {
    const renderPage = vi.fn(async () => ({ missingImages: false }));
    const a = api({ load: vi.fn(async () => ({ open: async () => ({ pages: 12, render: renderPage }) })) as unknown as PreviewApi['load'] });
    render(<PreviewPane file={{ path: 'x.pdf', name: 'x.pdf' }} api={a} download={dl} onClose={() => {}} />);
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole('button', { name: 'Show more pages' }));
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(8));
  });
});
