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
function host(onToolsCall: (msg: { id: number; params: unknown }, reply: (m: object) => void) => void, hostCapabilities: object = {}) {
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
              hostCapabilities,
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
    // No displayMode in the host context: inline inside the host's frame, so no second border.
    expect(h.w.document.querySelector('.fc-card')!.className).toBe('fc-card fc-card--embedded');
    // autoResize: the card reports its size to the host so the host can fit the frame.
    await until(() => h.methods.includes('ui/notifications/size-changed'), 2000);
    expect(h.methods).toContain('ui/notifications/size-changed');
    assertQuiet(h);
    h.w.close();
  }, 60000);

  it('ships the embedded rule and keeps its own frame only while the host shows it fullscreen', async () => {
    const h = host(() => {});
    await wait(50);
    h.send({ ...base, status: 'done' });
    await wait(50);
    const card = () => h.w.document.querySelector('.fc-card')!;
    const css = [...h.w.document.querySelectorAll('style')].map((s) => s.textContent).join('');
    expect(css).toMatch(/\.fc-card--embedded\{border:0;border-radius:0;box-shadow:none\}/);
    const mode = (displayMode: string) =>
      h.w.dispatchEvent(new h.w.MessageEvent('message', {
        source: h.w, data: { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode } },
      }));
    mode('fullscreen');
    await wait(50);
    expect(card().className).toBe('fc-card');
    mode('inline');
    await wait(50);
    expect(card().className).toBe('fc-card fc-card--embedded');
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

  it('answers a question from the card through frontier_answer when the host forwards app tool calls', async () => {
    const h = host((m, reply) => {
      const p = m.params as { name: string };
      if (p.name === 'frontier_answer') {
        reply({ result: { content: [{ type: 'text', text: 'Sent to Frontier.' }], structuredContent: { ...base, status: 'running', title: 'Carrying on', accepted: true } } });
      }
    }, { serverTools: {} });
    await wait(50);
    h.send({
      ...base, status: 'waiting_for_answer',
      open_ask: { ask_id: 'ask_0123456789abcdef0123', kind: 'question', questions: [{ id: 'q', kind: 'confirm', prompt: 'Go ahead?' }] },
    });
    await until(() => h.text().includes('Send answer'));
    const doc = h.w.document;
    const yes = [...doc.querySelectorAll('label')].find((l: any) => l.textContent === 'Yes') as any;
    yes.click();
    await wait(20);
    (doc.querySelector('button[type="submit"]') as any).click();
    await until(() => h.text().includes('Answered'));
    expect(h.toolCalls.find((c: any) => c.name === 'frontier_answer')).toMatchObject({
      name: 'frontier_answer',
      arguments: { task_id: 't1', ask_id: 'ask_0123456789abcdef0123', answers: [{ questionId: 'q', kind: 'confirm', value: true }] },
    });
    expect(h.text()).toContain('Carrying on');
    assertQuiet(h);
    h.w.close();
  }, 60000);

  it('without the serverTools capability the built card says to reply in the chat', async () => {
    const h = host(() => {});
    await wait(50);
    h.send({ ...base, status: 'waiting_for_answer', open_ask: { ask_id: 'ask_x', kind: 'question', questions: [{ id: 'q', kind: 'confirm', prompt: 'Go ahead?' }] } });
    await wait(100);
    expect(h.text()).toContain('Reply in the chat to answer.');
    expect(h.text()).not.toContain('Send answer');
    assertQuiet(h);
    h.w.close();
  }, 60000);

  it('renders a list result and re-queries frontier_list_tasks from a filter', async () => {
    const list = (title: string) => ({
      view: 'list', items: [{ task_id: 't9', title, status: 'done', started_at: '2026-10-18T09:00:00Z', source: 'frontier', work_ms: 1000, turn: 1 }],
      total: 1, shown: 1, next_cursor: null, filters: { days: 7, status: null, source: null }, capped: false,
    });
    const h = host((m, reply) => {
      if ((m.params as { name: string }).name === 'frontier_list_tasks') {
        reply({ result: { content: [{ type: 'text', text: 'ok' }], structuredContent: list('Filtered task') } });
      }
    }, { serverTools: {} });
    await wait(50);
    h.send(list('First task'));
    await until(() => h.text().includes('First task'));
    expect(h.text()).toContain('Your Frontier tasks');
    await until(() => !!h.w.document.querySelector('select'));
    const sel = h.w.document.querySelectorAll('select')[1] as any;
    sel.value = '3';
    sel.dispatchEvent(new h.w.Event('change', { bubbles: true }));
    await until(() => h.text().includes('Filtered task'));
    expect(h.toolCalls.find((c: any) => c.name === 'frontier_list_tasks')).toMatchObject({ arguments: { days: 7, status: 'done' } });
    assertQuiet(h);
    h.w.close();
  }, 60000);
});
