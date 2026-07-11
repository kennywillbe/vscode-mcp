import { describe, expect, it } from 'vitest';

import { SingleUseHandleStore } from './single-use-handle-store.js';

describe('single-use authority-bound handles', () => {
  it('consumes a valid handle exactly once', () => {
    const store = fixture();
    const token = store.create('edit', 3, 'workspace-a');
    expect(token).toBe('token-1');
    expect(store.take(token!, 3, 'workspace-a')).toEqual({
      status: 'ok',
      value: 'edit',
    });
    expect(store.take(token!, 3, 'workspace-a')).toEqual({ status: 'missing' });
  });

  it('fails closed for expiration, another generation, and another workspace', () => {
    let now = 1_000;
    let sequence = 0;
    const store = new SingleUseHandleStore<string>({
      maximumHandles: 4,
      lifetimeMs: 50,
      createToken: () => `token-${String(++sequence)}`,
      now: () => now,
    });
    const expired = store.create('expired', 1, 'workspace-a')!;
    now = 1_051;
    expect(store.take(expired, 1, 'workspace-a')).toEqual({ status: 'expired' });

    const oldGrant = store.create('grant', 1, 'workspace-a')!;
    expect(store.take(oldGrant, 2, 'workspace-a')).toEqual({
      status: 'authorityChanged',
    });
    const oldWorkspace = store.create('workspace', 2, 'workspace-a')!;
    expect(store.take(oldWorkspace, 2, 'workspace-b')).toEqual({
      status: 'authorityChanged',
    });
  });

  it('bounds handles, clears on lifecycle loss, and isolates store instances', () => {
    const first = fixture(1);
    const second = fixture(1);
    const token = first.create('first', 1, 'workspace-a')!;
    expect(first.create('overflow', 1, 'workspace-a')).toBeNull();
    expect(second.take(token, 1, 'workspace-a')).toEqual({ status: 'missing' });
    first.clear();
    expect(first.take(token, 1, 'workspace-a')).toEqual({ status: 'missing' });
  });
});

function fixture(maximumHandles = 4): SingleUseHandleStore<string> {
  let sequence = 0;
  return new SingleUseHandleStore({
    maximumHandles,
    lifetimeMs: 50,
    createToken: () => `token-${String(++sequence)}`,
    now: () => 1_000,
  });
}
