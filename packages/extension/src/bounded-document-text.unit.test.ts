import { describe, expect, it, vi } from 'vitest';

import {
  documentUtf16Length,
  readDocumentTextWithinLimit,
} from './bounded-document-text.js';

describe('readDocumentTextWithinLimit', () => {
  it('gets the document length without materializing its text', () => {
    expect(
      documentUtf16Length({
        positionAt: (offset) => Math.min(offset, 8 * 1024 * 1024),
        offsetAt: (position) => position,
      }),
    ).toBe(8 * 1024 * 1024);
  });

  it('does not materialize document text when its UTF-16 length exceeds the byte limit', () => {
    const getText = vi.fn(() => {
      throw new Error('oversized text must not be read');
    });

    expect(
      readDocumentTextWithinLimit(
        {
          positionAt: (offset) => Math.min(offset, 8 * 1024 * 1024),
          offsetAt: (position) => position,
          getText,
        },
        2 * 1024 * 1024,
      ),
    ).toBeUndefined();
    expect(getText).not.toHaveBeenCalled();
  });

  it('rejects multibyte text whose UTF-16 length fits but encoded bytes do not', () => {
    expect(
      readDocumentTextWithinLimit(
        {
          positionAt: (offset) => Math.min(offset, 2),
          offsetAt: (position) => position,
          getText: () => 'éé',
        },
        2,
      ),
    ).toBeUndefined();
  });

  it('returns text within both the UTF-16 and encoded-byte limit', () => {
    expect(
      readDocumentTextWithinLimit(
        {
          positionAt: (offset) => Math.min(offset, 4),
          offsetAt: (position) => position,
          getText: () => 'test',
        },
        4,
      ),
    ).toBe('test');
  });
});
