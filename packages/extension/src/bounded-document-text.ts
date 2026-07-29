interface TextDocumentReader<Position> {
  positionAt(offset: number): Position;
  offsetAt(position: Position): number;
  getText(): string;
}

export function documentUtf16Length<Position>(
  document: Pick<TextDocumentReader<Position>, 'positionAt' | 'offsetAt'>,
): number {
  return document.offsetAt(document.positionAt(Number.MAX_SAFE_INTEGER));
}

export function readDocumentTextWithinLimit<Position>(
  document: TextDocumentReader<Position>,
  maximumBytes: number,
): string | undefined {
  const probeOffset = maximumBytes + 1;
  if (document.offsetAt(document.positionAt(probeOffset)) >= probeOffset) {
    return undefined;
  }
  const text = document.getText();
  return Buffer.byteLength(text, 'utf8') <= maximumBytes ? text : undefined;
}
