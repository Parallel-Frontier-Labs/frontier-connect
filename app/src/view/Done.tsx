import { formatTokens, formatWork } from '../format';
import type { TaskPayload } from '../types';

export function Files({ files }: { files: { name: string }[] }) {
  if (!files.length) return null;
  return (
    <section class="fc-files" aria-label="Files">
      <h3 class="fc-h">Files</h3>
      <ul>
        {files.map((f, i) => (
          <li key={i}>{f.name}</li>
        ))}
      </ul>
    </section>
  );
}

export function Done({ payload }: { payload: TaskPayload }) {
  const { result, usage, work_ms } = payload;
  const tokens = usage ? usage.input_tokens + usage.output_tokens : null;
  return (
    <div class="fc-result">
      {result?.summary ? <p class="fc-summary">{result.summary}</p> : null}
      {result?.takeaway ? <p class="fc-takeaway">{result.takeaway}</p> : null}
      <p class="fc-meta">
        <span>{formatWork(work_ms)}</span>
        {tokens !== null ? <span>{formatTokens(tokens)}</span> : null}
      </p>
    </div>
  );
}
