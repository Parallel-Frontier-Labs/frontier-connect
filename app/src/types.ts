export const STATUSES = ['starting', 'running', 'waiting_for_answer', 'waiting_for_you', 'done', 'error', 'stopped'] as const;
export type Status = (typeof STATUSES)[number];
export interface Section { id: string; title: string; done: boolean; outcome: string | null }
export interface PlanStep { title: string; status: 'queued' | 'in_progress' | 'done' }
export interface Question { id?: string; kind?: string; prompt?: string; subPrompt?: string; options?: { id?: string; label?: string; description?: string }[] }
export interface OpenAsk { ask_id: string | null; kind: 'question' | 'files' | 'form'; questions?: Question[]; text?: string; form?: { title?: string; description?: string } | null }
export interface Usage { input_tokens: number; cached_input_tokens: number; output_tokens: number }
export interface View { token: string; expires_in_s: number; url: string }
export interface TaskPayload {
  task_id: string; status: Status; title: string; plan: PlanStep[]; sections: Section[]; live: string | null;
  estimate: { eta_s: number } | null; open_ask: OpenAsk | null; deliverables: { name: string }[];
  result: { summary: string; summary_type: string; takeaway: string | null } | null; work_ms: number;
  usage: Usage | null; events: unknown[]; cursor: number; more: boolean; view?: View | null;
}
export const TERMINAL: ReadonlySet<Status> = new Set(['done', 'error', 'stopped']);
export function isPayload(v: unknown): v is TaskPayload {
  return !!v && typeof v === 'object' && typeof (v as TaskPayload).task_id === 'string' && typeof (v as TaskPayload).status === 'string';
}

// Runtime sanitising. The payload comes from a network response or the host, so nothing in it is
// trusted: every field the card renders as text is forced to a string, and anything else is
// dropped (blank) rather than handed to the renderer. Numbers are kept only when finite.
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.map(obj).filter((o): o is Record<string, unknown> => o !== null) : [];

const PLAN_STATUS = ['queued', 'in_progress', 'done'] as const;
const ASK_KIND = ['question', 'files', 'form'] as const;

function cleanAsk(v: unknown): OpenAsk | null {
  const a = obj(v);
  if (!a) return null;
  const kind = ASK_KIND.find((k) => k === a.kind);
  if (!kind) return null;
  const form = obj(a.form);
  return {
    ask_id: strOrNull(a.ask_id),
    kind,
    text: optStr(a.text),
    form: form ? { title: optStr(form.title), description: optStr(form.description) } : null,
    questions: list(a.questions).map((q) => ({
      id: optStr(q.id),
      kind: optStr(q.kind),
      prompt: optStr(q.prompt),
      subPrompt: optStr(q.subPrompt),
      options: list(q.options).map((o) => ({ id: optStr(o.id), label: optStr(o.label), description: optStr(o.description) })),
    })),
  };
}

/** Validate and sanitise an untrusted payload; null when it is not a task payload at all. */
export function parsePayload(v: unknown): TaskPayload | null {
  if (!isPayload(v)) return null;
  const r = v as unknown as Record<string, unknown>;
  const est = obj(r.estimate);
  const res = obj(r.result);
  const use = obj(r.usage);
  const view = obj(r.view);
  const out: TaskPayload = {
    task_id: str(r.task_id),
    // Anything outside the enum (including "__proto__" or "constructor") falls back to the initial state.
    status: STATUSES.find((s) => s === r.status) ?? 'starting',
    title: str(r.title),
    plan: list(r.plan).map((p) => ({
      title: str(p.title),
      status: PLAN_STATUS.find((s) => s === p.status) ?? 'queued',
    })),
    sections: list(r.sections).map((s, i) => ({
      id: typeof s.id === 'string' ? s.id : String(i),
      title: str(s.title),
      done: s.done === true,
      outcome: strOrNull(s.outcome),
    })),
    live: strOrNull(r.live),
    estimate: est && typeof est.eta_s === 'number' && Number.isFinite(est.eta_s) ? { eta_s: est.eta_s } : null,
    open_ask: cleanAsk(r.open_ask),
    deliverables: list(r.deliverables).map((d) => ({ name: str(d.name) })).filter((d) => d.name !== ''),
    result: res ? { summary: str(res.summary), summary_type: str(res.summary_type), takeaway: strOrNull(res.takeaway) } : null,
    work_ms: num(r.work_ms),
    usage: use
      ? { input_tokens: num(use.input_tokens), cached_input_tokens: num(use.cached_input_tokens), output_tokens: num(use.output_tokens) }
      : null,
    events: Array.isArray(r.events) ? r.events : [],
    cursor: num(r.cursor),
    more: r.more === true,
  };
  if (r.view !== undefined) {
    out.view =
      view && typeof view.token === 'string' && typeof view.url === 'string'
        ? { token: view.token, expires_in_s: num(view.expires_in_s), url: view.url }
        : null;
  }
  return out;
}
