import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from '../src/markdown';

afterEach(cleanup);
const html = (t: string) => render(<Markdown text={t} />).container;

describe('Markdown', () => {
  it('renders paragraphs split on blank lines', () => {
    const c = html('First para.\n\nSecond para.');
    expect(Array.from(c.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['First para.', 'Second para.']);
  });

  it('renders # to ### as styled block text, never h1-h3', () => {
    const c = html('# One\n## Two\n### Three\n\nBody');
    expect(c.querySelector('h1,h2,h3')).toBeNull();
    const hs = Array.from(c.querySelectorAll('.fc-md-h'));
    expect(hs.map((h) => h.textContent)).toEqual(['One', 'Two', 'Three']);
    expect(hs[0].className).toContain('fc-md-h1');
  });

  it('renders bold, italic (* and _), and inline code', () => {
    const c = html('a **bold** b *it* c _under_ d `x < y`');
    expect(c.querySelector('strong')!.textContent).toBe('bold');
    expect(Array.from(c.querySelectorAll('em')).map((e) => e.textContent)).toEqual(['it', 'under']);
    expect(c.querySelector('code')!.textContent).toBe('x < y');
  });

  it('leaves snake_case words alone', () => {
    const c = html('use my_var_name here');
    expect(c.querySelector('em')).toBeNull();
    expect(c.textContent).toBe('use my_var_name here');
  });

  it('renders - * + bullet lists and numbered lists', () => {
    const c = html('- a\n- **b**\n* c\n\n1. one\n2. two');
    const uls = c.querySelectorAll('ul');
    expect(uls.length).toBe(1);
    expect(Array.from(uls[0].querySelectorAll('li')).map((l) => l.textContent)).toEqual(['a', 'b', 'c']);
    expect(uls[0].querySelector('li strong')!.textContent).toBe('b');
    expect(Array.from(c.querySelectorAll('ol li')).map((l) => l.textContent)).toEqual(['one', 'two']);
  });

  it('renders a link as its text only', () => {
    const c = html('see [the report](https://example.com/x) now');
    expect(c.querySelector('a')).toBeNull();
    expect(c.textContent).toBe('see the report now');
    expect(c.textContent).not.toContain('example.com');
  });

  it('renders javascript: links, images and html as inert text', () => {
    const c = html('[x](javascript:alert(1)) ![pic](https://e.com/a.png) <script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(c.querySelector('a, img, script')).toBeNull();
    expect(c.textContent).not.toContain('javascript:');
    expect(c.textContent).toContain('![pic](https://e.com/a.png)');
    expect(c.textContent).toContain('<script>alert(1)</script>');
    expect(c.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(c.innerHTML).not.toContain('<script');
  });

  it('keeps unbalanced markers as literal text without breaking', () => {
    const c = html('half **bold and a `tick and *star and _under\n\nnext **para');
    expect(c.querySelector('strong, em, code')).toBeNull();
    expect(c.textContent).toContain('**bold');
    expect(c.querySelectorAll('p').length).toBe(2);
  });

  it('handles pathological input quickly', () => {
    const t0 = Date.now();
    html('**'.repeat(10000) + '\n\n' + '*a '.repeat(5000) + '[' .repeat(5000));
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('empty text renders nothing', () => {
    expect(html('').textContent).toBe('');
  });

  it('a 6000-char heading line full of space runs renders fast (no regex backtracking)', () => {
    const t0 = performance.now();
    const c = html('# a' + '  '.repeat(2998) + 'x');
    expect(performance.now() - t0).toBeLessThan(50);
    expect(c.querySelector('.fc-md-h')!.textContent!.endsWith('x')).toBe(true);
  });

  it('strips a closing # run from a heading but keeps a # inside the text', () => {
    expect(html('## Title ##').querySelector('.fc-md-h')!.textContent).toBe('Title');
    expect(html('## C# notes').querySelector('.fc-md-h')!.textContent).toBe('C# notes');
  });

  it('many failed underscore closers stay linear', () => {
    const t0 = performance.now();
    html(' _x'.repeat(6600) + ' _');
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
