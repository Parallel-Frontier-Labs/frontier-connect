/** The task's prompt in the full-screen task pane: shown in full, as text, never as markup. */
export type PromptState = { kind: 'loading' } | { kind: 'ok'; text: string; truncated: boolean } | { kind: 'none' };

export function PromptBlock({ prompt, turns }: { prompt: PromptState; turns: number }) {
  if (prompt.kind !== 'ok' || !prompt.text.trim()) return null;
  return (
    <section class="fc-prompt" aria-label="Prompt">
      <div class="fc-prompt-head">
        <h2 class="fc-cap">Prompt</h2>
        {turns > 1 ? <span class="fc-mono fc-faint fc-prompt-turns">{`${turns} turns`}</span> : null}
      </div>
      <blockquote class="fc-prompt-text">{prompt.text}{prompt.truncated ? '…' : ''}</blockquote>
    </section>
  );
}
