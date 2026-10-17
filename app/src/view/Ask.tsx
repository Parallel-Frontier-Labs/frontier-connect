import type { OpenAsk } from '../types';

export function Ask({ ask }: { ask: OpenAsk }) {
  if (ask.kind === 'files') {
    return (
      <section class="fc-ask" aria-label="Files needed">
        {ask.text ? <p class="fc-text">{ask.text}</p> : null}
        <p class="fc-hint">Attach the files in the chat.</p>
      </section>
    );
  }
  if (ask.kind === 'form') {
    return (
      <section class="fc-ask" aria-label="Form">
        {ask.form?.title ? <h3 class="fc-h">{ask.form.title}</h3> : null}
        {ask.form?.description ? <p class="fc-text">{ask.form.description}</p> : null}
        <p class="fc-hint">Open Frontier to fill in this form.</p>
      </section>
    );
  }
  return (
    <section class="fc-ask" aria-label="Question">
      {(ask.questions ?? []).map((q, i) => (
        <div key={q.id ?? i} class="fc-q">
          {q.prompt ? <h3 class="fc-h">{q.prompt}</h3> : null}
          {q.subPrompt ? <p class="fc-muted">{q.subPrompt}</p> : null}
          {q.options?.length ? (
            <ul class="fc-opts">
              {q.options.map((o, j) => (
                <li key={o.id ?? j}>
                  <span>{o.label}</span>
                  {o.description ? <span class="fc-muted"> · {o.description}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
      <p class="fc-hint">Reply in the chat to answer.</p>
    </section>
  );
}
