export type VisualTextChangeKind = 'added' | 'modified' | 'deleted';

export interface VisualTextEditInput {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly newTextLength: number;
}

export interface ProjectedVisualTextChange {
  readonly kind: VisualTextChangeKind;
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * Projects validated, non-overlapping pre-edit UTF-16 offsets into the document state
 * that exists after one atomic WorkspaceEdit commit.
 */
export function projectVisualTextChanges(
  edits: readonly VisualTextEditInput[],
): readonly ProjectedVisualTextChange[] {
  const ordered = [...edits].sort(
    (left, right) =>
      left.startOffset - right.startOffset || left.endOffset - right.endOffset,
  );
  let delta = 0;
  return ordered.map((edit) => {
    const replacedLength = edit.endOffset - edit.startOffset;
    const startOffset = edit.startOffset + delta;
    const endOffset = startOffset + edit.newTextLength;
    const kind: VisualTextChangeKind =
      edit.newTextLength === 0
        ? 'deleted'
        : replacedLength === 0
          ? 'added'
          : 'modified';
    delta += edit.newTextLength - replacedLength;
    return { kind, startOffset, endOffset };
  });
}
