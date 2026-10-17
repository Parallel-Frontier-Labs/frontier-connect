import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 15000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(25);
}

const base = {
  task_id: 't1', status: 'running', title: 'Quarterly review', plan: [], sections: [], live: null,
  estimate: null, open_ask: null, deliverables: [], result: null, work_ms: 0, usage: null,
  events: [], cursor: 1, more: false, view: null,
};
// A view whose fetch rejects, so the poller falls back to the host bridge on its first tick.
const view = { token: 'tok', expires_in_s: 3600, url: 'https://view.invalid/v1/runs/t1/view' };

// Runs the built file (dist/task-card.html, built once by the vitest globalSetup) against a
// scripted host. This catches build-time trimming that would break the SDK at runtime, including
// callServerTool response parsing, which is the one path that could reach a stubbed zod part.
function host(onToolsCall: (msg: { id: number; params: unknown }, reply: (m: object) => void) => void) {
  const html = readFileSync('dist/task-card.html', 'utf8');
  const methods: string[] = [];
  const toolCalls: unknown[] = [];
  const errors: string[] = [];
  const warns: string[] = [];
  const vc = new VirtualConsole();
  vc.on('error', (...a: unknown[]) => errors.push(a.map(String).join(' ')));
  vc.on('jsdomError', (e: unknown) => errors.push(String((e as Error)?.stack ?? e)));
  vc.on('warn', (...a: unknown[]) => warns.push(a.map(String).join(' ')));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w: any) {
      // jsdom has no ResizeObserver; the SDK's auto-resize needs one.
      w.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      w.fetch = () => Promise.reject(new TypeError('network down'));
      const reply = (data: object) =>
        setTimeout(() => w.dispatchEvent(new w.MessageEvent('message', { data, source: w })), 0);
      w.postMessage = ((msg: { id?: number; method?: string; params?: unknown }) => {
        if (msg.method) methods.push(msg.method);
        if (msg.method === 'ui/initialize') {
          reply({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2026-01-26',
              hostInfo: { name: 'test-host', version: '1' },
              hostCapabilities: {},
              hostContext: { theme: 'dark' },
            },
          });
        } else if (msg.method === 'tools/call') {
          toolCalls.push(msg.params);
          onToolsCall({ id: msg.id as number, params: msg.params }, (m) => reply({ jsonrpc: '2.0', id: msg.id, ...m }));
        }
      }) as typeof w.postMessage;
    },
  });
  const w = dom.window;
  const send = (structuredContent: unknown) =>
    w.dispatchEvent(
      new w.MessageEvent('message', {
        source: w,
        data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent } },
      }),
    );
  const text = () => w.document.getElementById('root')!.textContent ?? '';
  return { w, methods, toolCalls, errors, warns, send, text };
}

// Console noise that the SDK is known to emit in this harness. Keep empty unless unavoidable.
const KNOWN_WARNINGS: RegExp[] = [];
function assertQuiet(h: { errors: string[]; warns: string[] }) {
  expect(h.errors).toEqual([]);
  expect(h.warns.filter((l) => !KNOWN_WARNINGS.some((re) => re.test(l)))).toEqual([]);
}

describe('built card in a scripted host', () => {
  it('handshakes and renders a tool result', async () => {
    const h = host(() => {});
    await wait(50);
    expect(h.methods).toContain('ui/initialize');
    expect(h.text()).toContain('Loading the task');
    h.send({ ...base, status: 'done' });
    await wait(50);
    expect(h.text()).toContain('Quarterly review');
    expect(h.w.document.documentElement.dataset.theme).toBe('dark');
    assertQuiet(h);
    h.w.close();
  }, 60000);

  it('falls back to host tools/call and renders the CallToolResult payload', async () => {
    const h = host((_m, reply) =>
      reply({
        result: {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { ...base, title: 'Fresh from the host', cursor: 7, status: 'done' },
        },
      }),
    );
    await wait(50);
    h.send({ ...base, view });
    await wait(50);
    expect(h.text()).toContain('Quarterly review');
    await until(() => h.text().includes('Fresh from the host'));
    expect(h.text()).toContain('Fresh from the host');
    expect(h.toolCalls[0]).toMatchObject({ name: 'frontier_get_task', arguments: { task_id: 't1', after: 1 } });
    assertQuiet(h);
    h.w.close();
  }, 60000);

  it('keeps its state when the host answers tools/call with a JSON-RPC error', async () => {
    const h = host((_m, reply) => reply({ error: { code: -32603, message: 'host refused' } }));
    await wait(50);
    h.send({ ...base, view });
    await until(() => h.toolCalls.length > 0);
    expect(h.toolCalls[0]).toMatchObject({ name: 'frontier_get_task', arguments: { task_id: 't1', after: 1 } });
    await wait(200);
    expect(h.text()).toContain('Quarterly review');
    expect(h.text()).not.toContain('Loading the task');
    assertQuiet(h);
    h.w.close();
  }, 60000);
});
