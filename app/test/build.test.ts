import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('single-file build', () => {
  it('produces one self-contained HTML file within the size budget', () => {
    const f = 'dist/task-card.html';
    const html = readFileSync(f, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(statSync(f).size).toBeLessThanOrEqual(460800);
    expect(html).not.toMatch(/<script[^>]*\ssrc/i);
    expect(html).not.toMatch(/<link\s/i);
    expect(html).toContain('id="root"');
  });

  it('embeds Public Sans 400/600/700 and IBM Plex Mono 400 as data URLs, with the font notice', () => {
    const html = readFileSync('dist/task-card.html', 'utf8');
    for (const w of [400, 600, 700]) expect(html).toMatch(new RegExp(`font-family:'Public Sans';font-style:normal;font-weight:${w};[^}]*url\\(data:font/woff2;base64,`));
    expect(html).toMatch(/font-family:'IBM Plex Mono';font-style:normal;font-weight:400;[^}]*url\(data:font\/woff2;base64,/);
    // OFL 1.1 condition 2: every copy carries the copyright lines and the license text.
    const ofl = readFileSync('LICENSES/OFL-1.1.txt', 'utf8');
    expect(html).toContain(ofl);
    expect(html).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(html).toContain('PERMISSION & CONDITIONS');
    expect(html).toContain('Copyright 2015 The Public Sans Project Authors');
    expect(html).toContain('Copyright 2017 IBM Corp.');
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(css).not.toMatch(/url\((?!data:)/);
  });

  // Any new runtime URL (a new dependency, a hard-coded endpoint) must be reviewed and added here.
  it('contains only the known library URL constants', () => {
    const html = readFileSync('dist/task-card.html', 'utf8');
    const found = [...new Set(html.match(/https?:\/\/[^"'`\\\s)<>,;]*/g) ?? [])].sort();
    expect(found).toEqual([
      'http://[${e}]',
      'http://json-schema.org/draft/2019-09/schema',
      'http://www.w3.org/1998/Math/MathML',
      'http://www.w3.org/1999/xhtml',
      'http://www.w3.org/2000/svg',
      'https://*.example.com',
      'https://github.com/cfworker',
      'https://github.com/uswds/public-sans',
      'https://json-schema.org/draft/2019-09/schema',
      'https://openfontlicense.org',
    ]);
  });
});
