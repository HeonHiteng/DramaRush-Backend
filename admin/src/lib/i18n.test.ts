import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { format, MESSAGES, t } from './i18n';

const SRC = join(__dirname, '..');
const HAN = /[一-鿿]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') && name !== 'i18n.tsx' ? [path] : [];
  });
}

describe('i18n', () => {
  it('defaults to English and fills placeholders', () => {
    expect(t('dash.publishedOf', { published: 3, total: 5 })).toBe('3 / 5 episodes published');
    expect(format('{a} and {missing}', { a: 'x' })).toBe('x and {missing}');
  });

  it('has a Chinese text for every key, with the same placeholders', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, en] of Object.entries(MESSAGES.en)) {
      const zh = MESSAGES.zh[key as keyof typeof MESSAGES.en];
      expect(zh, key).toBeTruthy();
      expect(vars(zh), key).toEqual(vars(en));
    }
  });

  it('leaves no hard-coded Chinese in the UI code (put it in i18n.tsx)', () => {
    const offenders = sourceFiles(SRC).filter((file) => {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      return HAN.test(code);
    });
    expect(offenders).toEqual([]);
  });
});
