import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('single-file build', () => {
  it('produces one self-contained HTML file within the size budget', () => {
    const f = 'dist/task-card.html';
    const html = readFileSync(f, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(statSync(f).size).toBeLessThanOrEqual(307200);
    expect(html).not.toMatch(/<script[^>]*\ssrc/i);
    expect(html).not.toMatch(/<link\s/i);
    expect(html).toContain('id="root"');
  });

  // Any new runtime URL (a new dependency, a hard-coded endpoint) must be reviewed and added here.
  it('contains only the known library URL constants', () => {
    const html = readFileSync('dist/task-card.html', 'utf8');
    const found = [...new Set(html.match(/https?:\/\/[^"'`\\ )<>,;]*/g) ?? [])].sort();
    expect(found).toEqual([
      'http://[${e}]',
      'http://json-schema.org/draft/2019-09/schema',
      'http://www.w3.org/1998/Math/MathML',
      'http://www.w3.org/1999/xhtml',
      'http://www.w3.org/2000/svg',
      'https://*.example.com',
      'https://github.com/cfworker',
      'https://json-schema.org/draft/2019-09/schema',
    ]);
  });
});
