import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// tsc has no switch for explicit `any` (noImplicitAny only covers the inferred kind), and ESLint's
// TypeScript support can't run on TypeScript 7 yet. So: a test, which CI already runs. It strips
// comments, strings and regex literals, then rejects the `any` keyword anywhere that's left.
// Reach for `unknown` and narrow instead; see errorMessage() in src/logger.ts for the usual case.

const root = new URL('..', import.meta.url).pathname;

function tsFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? tsFiles(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
}

/** Blanks out comments, string/template literals and regex literals, keeping newlines so line
 * numbers survive. Regex literals are recognised by what precedes the `/` — the usual heuristic,
 * which can't tell `if (x) /re/` from division without a parser; nothing here is written that way. */
export function codeOnly(source: string): string {
  let out = '';
  let i = 0;
  let lastSignificant = '';
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    let end = -1;
    if (c === '/' && next === '/') {
      end = source.indexOf('\n', i);
      if (end === -1) end = source.length;
    } else if (c === '/' && next === '*') {
      end = source.indexOf('*/', i + 2) + 2;
      if (end === 1) end = source.length;
    } else if (c === '"' || c === "'" || c === '`') {
      end = i + 1;
      while (end < source.length && source[end] !== c) end += source[end] === '\\' ? 2 : 1;
      end += 1;
    } else if (c === '/' && (lastSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant) || /\breturn\s*$/.test(out))) {
      end = i + 1;
      let inClass = false;
      while (end < source.length && source[end] !== '\n' && (inClass || source[end] !== '/')) {
        if (source[end] === '\\') end += 1;
        else if (source[end] === '[') inClass = true;
        else if (source[end] === ']') inClass = false;
        end += 1;
      }
      end += 1;
    }
    if (end !== -1) {
      out += blank(source.slice(i, end));
      const isComment = c === '/' && (next === '/' || next === '*');
      if (!isComment) lastSignificant = ')'; // a string or regex literal is a value: `/` after it divides
      i = end;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i += 1;
  }
  return out;
}

function explicitAnys(file: string): string[] {
  return codeOnly(readFileSync(join(root, file), 'utf8'))
    .split('\n')
    .flatMap((line, n) => (/\bany\b/.test(line) ? [`${file}:${n + 1}: ${line.trim()}`] : []));
}

describe('no explicit any', () => {
  it('src/ and tests/ contain no `any` type', () => {
    const offenders = [...tsFiles('src'), ...tsFiles('tests')].flatMap(explicitAnys);
    assert.deepEqual(offenders, [], `use \`unknown\` and narrow instead:\n${offenders.join('\n')}`);
  });

  it('catches the forms it is meant to, and ignores the word in prose', () => {
    const found = (code: string) => /\bany\b/.test(codeOnly(code));
    for (const code of ['let x: any;', 'f(y as any)', 'const a: any[] = [];', 'type R = Record<string, any>;', 'g<any>()']) {
      assert.ok(found(code), code);
    }
    for (const code of [
      '// any comment',
      '/* any */ let x = 1;',
      "const s = 'any string';",
      'const t = `any ${1}`;',
      'const r = /any|"quote/g; let y: number;',
      'const ok = cond && /any/.test(b);',
      'const half = total / 2; const s = "any";',
    ]) {
      assert.ok(!found(code), code);
    }
  });
});
