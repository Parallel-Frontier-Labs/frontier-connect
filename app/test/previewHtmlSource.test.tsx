import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/preview/kind', async () => ({ ...(await vi.importActual<typeof import('../src/preview/kind')>('../src/preview/kind')), HTML_FRAME: false }));
import { PreviewPane } from '../src/view/PreviewPane';

afterEach(cleanup);

it('shows the source with a note when the HTML frame is switched off', async () => {
  const api = { bytes: async () => ({ kind: 'ok' as const, bytes: new TextEncoder().encode('<p>raw page</p>') }), load: (async () => { throw new Error('n/a'); }) as never };
  const { container } = render(<PreviewPane file={{ path: 'd.html', name: 'd.html' }} api={api} download={{ enabled: true, get: async () => ({ kind: 'opened' as const }) }} onClose={() => {}} />);
  expect(await screen.findByText("Showing this page's source. Download it to open it in your browser.")).toBeTruthy();
  expect(screen.getByText('<p>raw page</p>')).toBeTruthy();
  expect(container.querySelector('iframe')).toBeNull();
});
