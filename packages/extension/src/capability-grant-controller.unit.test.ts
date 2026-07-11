import { describe, expect, it } from 'vitest';

import { CapabilityGrantController } from './capability-grant-controller.js';

describe('CapabilityGrantController', () => {
  it('starts denied and keeps write and execution independent', () => {
    const grants = new CapabilityGrantController();
    expect(grants.capture('write')).toBeNull();
    expect(grants.capture('execution')).toBeNull();

    const write = grants.grant('write');
    expect(grants.isCurrent(write)).toBe(true);
    expect(grants.snapshot().execution).toBe(false);
  });

  it('invalidates captured authority when revoked and regranted', () => {
    const grants = new CapabilityGrantController();
    const first = grants.grant('write');
    grants.revoke('write');
    const second = grants.grant('write');

    expect(grants.isCurrent(first)).toBe(false);
    expect(grants.isCurrent(second)).toBe(true);
    expect(second.generation).toBeGreaterThan(first.generation);
  });

  it('revokes every grant on disposal and cannot be re-enabled', () => {
    const grants = new CapabilityGrantController();
    const write = grants.grant('write');
    const execution = grants.grant('execution');
    grants.dispose();

    expect(grants.isCurrent(write)).toBe(false);
    expect(grants.isCurrent(execution)).toBe(false);
    expect(() => grants.grant('write')).toThrow(/disposed/);
  });
});
