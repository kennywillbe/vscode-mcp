import { describe, expect, it } from 'vitest';

import {
  limitBoundedProviderItems,
  readBoundedProviderItems,
  saturatingAddProviderCounts,
  snapshotBoundedProviderItems,
  snapshotBoundedProviderItemsWithPrefix,
} from './provider-output-bounds.js';

describe('provider output bounds', () => {
  it('copies by numeric index and never reads the first omitted provider item', () => {
    const source = new Proxy([1, 2, 3, 4], {
      get(target, property, receiver) {
        if (property === '3' || property === Symbol.iterator) {
          throw new Error('read beyond provider budget');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(snapshotBoundedProviderItems(source, 3, (value) => value * 2)).toEqual({
      items: [2, 4, 6],
      omittedCount: 1,
    });
  });

  it('does not invoke an accessor at cap plus one', () => {
    const source = [1, 2, 3];
    Object.defineProperty(source, 2, {
      get(): never {
        throw new Error('cap plus one was inspected');
      },
    });

    expect(snapshotBoundedProviderItems(source, 2)).toEqual({
      items: [1, 2],
      omittedCount: 1,
    });
  });

  it('treats sparse or undefined provider entries as bounded omissions', () => {
    const source = new Array<number>(4);
    source[0] = 1;
    source[2] = 3;
    source[3] = 4;

    expect(snapshotBoundedProviderItems(source, 3)).toEqual({
      items: [1, 3],
      omittedCount: 2,
    });
  });

  it('reuses an inspected prefix without rereading accessors or touching the suffix', () => {
    const reads = [0, 0, 0, 0];
    const source = new Proxy(['a', 'b', 'c', 'd'], {
      get(target, property, receiver) {
        if (property === Symbol.iterator || property === '3') {
          throw new Error('unbounded provider access');
        }
        if (typeof property === 'string' && /^[0-2]$/.test(property)) {
          const index = Number(property);
          reads[index] = (reads[index] ?? 0) + 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const prefix = [source[0] ?? '', source[1] ?? ''];

    expect(
      snapshotBoundedProviderItemsWithPrefix(source, prefix, 3, (value) =>
        value.toUpperCase(),
      ),
    ).toEqual({ items: ['A', 'B', 'C'], omittedCount: 1 });
    expect(reads).toEqual([1, 1, 1, 0]);
  });

  it('reapplies a smaller service limit without double-counting omissions', () => {
    expect(
      limitBoundedProviderItems({ items: ['a', 'b', 'c'], omittedCount: 4 }, 2),
    ).toEqual({ items: ['a', 'b'], omittedCount: 5 });
    expect(readBoundedProviderItems({ items: ['a', 'b'], omittedCount: 3 }, 1)).toEqual(
      { items: ['a'], omittedCount: 4 },
    );
  });

  it('rejects malformed snapshots and saturates omission arithmetic', () => {
    expect(readBoundedProviderItems({ items: [], omittedCount: -1 }, 1)).toBeNull();
    expect(saturatingAddProviderCounts(Number.MAX_SAFE_INTEGER - 1, 10)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(saturatingAddProviderCounts(1, Number.POSITIVE_INFINITY)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});
