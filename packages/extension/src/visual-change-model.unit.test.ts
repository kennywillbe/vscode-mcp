import { describe, expect, it } from 'vitest';

import { projectVisualTextChanges } from './visual-change-model.js';

describe('visual change projection', () => {
  it('projects ordered insert, replace, and delete offsets into the committed document', () => {
    expect(
      projectVisualTextChanges([
        { startOffset: 10, endOffset: 12, newTextLength: 0 },
        { startOffset: 2, endOffset: 2, newTextLength: 3 },
        { startOffset: 6, endOffset: 8, newTextLength: 4 },
      ]),
    ).toEqual([
      { kind: 'added', startOffset: 2, endOffset: 5 },
      { kind: 'modified', startOffset: 9, endOffset: 13 },
      { kind: 'deleted', startOffset: 15, endOffset: 15 },
    ]);
  });

  it('uses UTF-16 code-unit lengths supplied by the caller', () => {
    expect(
      projectVisualTextChanges([
        { startOffset: 0, endOffset: 0, newTextLength: '😀'.length },
      ]),
    ).toEqual([{ kind: 'added', startOffset: 0, endOffset: 2 }]);
  });

  it('keeps adjacent changes distinct for exact navigation and hover attribution', () => {
    expect(
      projectVisualTextChanges([
        { startOffset: 0, endOffset: 1, newTextLength: 1 },
        { startOffset: 1, endOffset: 1, newTextLength: 1 },
      ]),
    ).toEqual([
      { kind: 'modified', startOffset: 0, endOffset: 1 },
      { kind: 'added', startOffset: 1, endOffset: 2 },
    ]);
  });
});
