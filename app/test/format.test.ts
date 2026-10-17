import { describe, expect, it } from 'vitest';
import { formatEta, formatTokens, formatWork } from '../src/format';

describe('formatTokens', () => {
  it('prints small and thousand values', () => {
    expect(formatTokens(5)).toBe('5 tokens');
    expect(formatTokens(999)).toBe('999 tokens');
    expect(formatTokens(12_300)).toBe('12.3k tokens');
    expect(formatTokens(999_949)).toBe('999.9k tokens');
  });
  it('switches to M at 999.95k, never printing 1000.0k', () => {
    expect(formatTokens(999_950)).toBe('1.0M tokens');
    expect(formatTokens(999_999)).toBe('1.0M tokens');
    expect(formatTokens(1_500_000)).toBe('1.5M tokens');
  });
});

describe('formatWork', () => {
  it('formats seconds and minutes', () => {
    expect(formatWork(0)).toBe('0s');
    expect(formatWork(4_000)).toBe('4s');
    expect(formatWork(65_000)).toBe('1m 5s');
    expect(formatWork(-5)).toBe('0s');
  });
});

describe('formatEta', () => {
  it('says less than a minute under 45 s', () => {
    expect(formatEta(0)).toBe('Less than a minute left');
    expect(formatEta(44)).toBe('Less than a minute left');
  });
  it('rounds to minutes from 45 s', () => {
    expect(formatEta(45)).toBe('About 1 min left');
    expect(formatEta(240)).toBe('About 4 min left');
  });
});
