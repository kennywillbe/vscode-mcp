import { describe, expect, it } from 'vitest';

import { createInstanceCredentials, credentialsMatch } from './credentials.js';

describe('IPC credentials', () => {
  it('creates independent fixed-size credentials', () => {
    const first = createInstanceCredentials();
    const second = createInstanceCredentials();

    expect(first.instanceId).not.toBe(second.instanceId);
    expect(first.authToken).toHaveLength(43);
    expect(first.authToken).not.toBe(second.authToken);
    expect(first.endpointEntropy).toHaveLength(22);
    expect(first.endpointEntropy).not.toBe(second.endpointEntropy);
  });

  it('matches only the complete instance and token pair', () => {
    const expected = createInstanceCredentials();
    const other = createInstanceCredentials();

    expect(
      credentialsMatch(
        expected.instanceId,
        expected.authToken,
        expected.instanceId,
        expected.authToken,
      ),
    ).toBe(true);
    expect(
      credentialsMatch(
        expected.instanceId,
        expected.authToken,
        other.instanceId,
        expected.authToken,
      ),
    ).toBe(false);
    expect(
      credentialsMatch(
        expected.instanceId,
        expected.authToken,
        expected.instanceId,
        other.authToken,
      ),
    ).toBe(false);
  });

  it('handles malformed candidate tokens through the same false result', () => {
    const expected = createInstanceCredentials();

    expect(
      credentialsMatch(
        expected.instanceId,
        expected.authToken,
        expected.instanceId,
        'not-a-valid-token',
      ),
    ).toBe(false);
  });
});
