/**
 * A provider collection copied through a fixed raw-item budget. `omittedCount`
 * describes source positions that were not materialized: positions beyond the budget
 * plus sparse/undefined positions inside it. Non-empty malformed items remain in
 * `items` so callers can account for them separately without double-counting.
 */
export interface BoundedProviderItems<Value> {
  readonly items: readonly Value[];
  readonly omittedCount: number;
}

/** Adds two provider omission counts without exceeding the safe integer range. */
export function saturatingAddProviderCounts(left: number, right: number): number {
  const normalizedLeft = normalizeProviderCount(left);
  const normalizedRight = normalizeProviderCount(right);
  return normalizedLeft >= Number.MAX_SAFE_INTEGER - normalizedRight
    ? Number.MAX_SAFE_INTEGER
    : normalizedLeft + normalizedRight;
}

/**
 * Copies at most `maximumItems` by numeric index. Provider-owned arrays must not be
 * mapped, sliced, spread, searched, or iterated before this boundary: accessors and
 * proxies can otherwise make an apparently harmless conversion traverse unbounded
 * provider output.
 */
export function snapshotBoundedProviderItems<Input>(
  source: readonly Input[],
  maximumItems: number,
): BoundedProviderItems<Input>;
export function snapshotBoundedProviderItems<Input, Output>(
  source: readonly Input[],
  maximumItems: number,
  mapItem: (item: Input, index: number) => Output,
): BoundedProviderItems<Output>;
export function snapshotBoundedProviderItems<Input, Output>(
  source: readonly Input[],
  maximumItems: number,
  mapItem?: (item: Input, index: number) => Output,
): BoundedProviderItems<Input | Output> {
  return mapItem === undefined
    ? snapshotBoundedProviderItemsWithPrefix(source, [], maximumItems)
    : snapshotBoundedProviderItemsWithPrefix(source, [], maximumItems, mapItem);
}

/**
 * Copies a provider prefix whose values were already inspected, then resumes numeric
 * source access after that prefix. Shape detection can therefore reuse its physical
 * reads without touching an accessor twice.
 */
export function snapshotBoundedProviderItemsWithPrefix<Input>(
  source: readonly Input[],
  inspectedPrefix: readonly Input[],
  maximumItems: number,
): BoundedProviderItems<Input>;
export function snapshotBoundedProviderItemsWithPrefix<Input, Output>(
  source: readonly Input[],
  inspectedPrefix: readonly Input[],
  maximumItems: number,
  mapItem: (item: Input, index: number) => Output,
): BoundedProviderItems<Output>;
export function snapshotBoundedProviderItemsWithPrefix<Input, Output>(
  source: readonly Input[],
  inspectedPrefix: readonly Input[],
  maximumItems: number,
  mapItem?: (item: Input, index: number) => Output,
): BoundedProviderItems<Input | Output> {
  assertMaximumItems(maximumItems);
  const sourceLength = normalizeProviderCount(source.length);
  const copiedCount = Math.min(sourceLength, maximumItems);
  if (inspectedPrefix.length > copiedCount) {
    throw new RangeError('The inspected provider prefix exceeds the bounded copy.');
  }
  const items: Array<Input | Output> = [];
  let omittedCount = normalizeProviderCount(sourceLength - copiedCount);
  for (let index = 0; index < inspectedPrefix.length; index += 1) {
    const item = inspectedPrefix[index];
    if (item === undefined) {
      omittedCount = saturatingAddProviderCounts(omittedCount, 1);
      continue;
    }
    items.push(mapItem === undefined ? item : mapItem(item, index));
  }
  for (let index = inspectedPrefix.length; index < copiedCount; index += 1) {
    const item = source[index];
    if (item === undefined) {
      omittedCount = saturatingAddProviderCounts(omittedCount, 1);
      continue;
    }
    items.push(mapItem === undefined ? item : mapItem(item, index));
  }
  return { items, omittedCount };
}

/** Re-applies a smaller limit while preserving an upstream omission count exactly. */
export function limitBoundedProviderItems<Value>(
  source: BoundedProviderItems<Value>,
  maximumItems: number,
): BoundedProviderItems<Value> {
  const bounded = snapshotBoundedProviderItems(source.items, maximumItems);
  return {
    items: bounded.items,
    omittedCount: saturatingAddProviderCounts(
      source.omittedCount,
      bounded.omittedCount,
    ),
  };
}

/**
 * Accepts either an already bounded internal snapshot or a raw provider array and
 * applies the local limit. This is the service-side defense in depth for test hosts
 * and future adapters; malformed wrapper objects are rejected rather than trusted.
 */
export function readBoundedProviderItems(
  source: unknown,
  maximumItems: number,
): BoundedProviderItems<unknown> | null {
  if (Array.isArray(source)) {
    return snapshotBoundedProviderItems(source, maximumItems);
  }
  if (typeof source !== 'object' || source === null) {
    return null;
  }
  const record = source as Readonly<Record<string, unknown>>;
  const items = record['items'];
  const omittedCount = record['omittedCount'];
  if (
    !Array.isArray(items) ||
    typeof omittedCount !== 'number' ||
    !Number.isSafeInteger(omittedCount) ||
    omittedCount < 0
  ) {
    return null;
  }
  return limitBoundedProviderItems({ items, omittedCount }, maximumItems);
}

function assertMaximumItems(maximumItems: number): void {
  if (!Number.isSafeInteger(maximumItems) || maximumItems < 0) {
    throw new RangeError(
      'The provider item limit must be a non-negative safe integer.',
    );
  }
}

function normalizeProviderCount(value: number): number {
  if (Number.isNaN(value) || value <= 0) {
    return 0;
  }
  if (!Number.isFinite(value)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}
