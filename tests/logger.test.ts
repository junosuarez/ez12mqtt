import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { stringify } from '../src/logger.ts';

describe('logger stringify', () => {
  it('replaces a true cycle instead of throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    assert.equal(stringify({ a }), '{"a":{"name":"a","self":"[Circular]"}}');
  });

  it('keeps a shared, non-circular reference everywhere it appears', () => {
    const shared = { n: 1 };
    assert.equal(stringify({ x: shared, y: [shared, shared] }), '{"x":{"n":1},"y":[{"n":1},{"n":1}]}');
  });

  it('matches plain JSON.stringify when there are no cycles', () => {
    const value = { level: 'info', nested: { list: [1, { deep: true }], empty: {} }, n: null };
    assert.equal(stringify(value), JSON.stringify(value));
  });
});
