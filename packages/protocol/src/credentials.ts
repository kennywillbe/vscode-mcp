import {
  createHash,
  randomBytes as cryptographicRandomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { PROTOCOL_LIMITS } from './constants.js';
import { AuthTokenSchema, InstanceIdSchema } from './schemas.js';

export interface InstanceCredentials {
  instanceId: string;
  authToken: string;
  endpointEntropy: string;
}

export interface InstanceCredentialDependencies {
  readonly randomBytes: (size: number) => Uint8Array;
}

export const NODE_INSTANCE_CREDENTIAL_DEPENDENCIES: InstanceCredentialDependencies = {
  randomBytes: cryptographicRandomBytes,
};

export function createInstanceCredentials(
  dependencies: InstanceCredentialDependencies = NODE_INSTANCE_CREDENTIAL_DEPENDENCIES,
): InstanceCredentials {
  const instanceId = randomUUID();
  const authToken = encodeEntropy(
    dependencies.randomBytes(PROTOCOL_LIMITS.authTokenBytes),
    PROTOCOL_LIMITS.authTokenBytes,
  );
  const endpointEntropy = encodeEntropy(
    dependencies.randomBytes(PROTOCOL_LIMITS.endpointEntropyBytes),
    PROTOCOL_LIMITS.endpointEntropyBytes,
  );

  return {
    instanceId: InstanceIdSchema.parse(instanceId),
    authToken: AuthTokenSchema.parse(authToken),
    endpointEntropy,
  };
}

function encodeEntropy(value: Uint8Array, expectedBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength !== expectedBytes) {
    throw new Error('IPC credential entropy has an invalid byte length.');
  }
  return bytes.toString('base64url');
}

/**
 * Performs fixed-size comparisons for both credentials. Callers must return the same
 * external error for every false result.
 */
export function credentialsMatch(
  expectedInstanceId: string,
  expectedAuthToken: string,
  candidateInstanceId: string,
  candidateAuthToken: string,
): boolean {
  const expectedTokenBytes = decodeExpectedToken(expectedAuthToken);
  const candidateTokenBytes = decodeCandidateToken(candidateAuthToken);
  const tokenMatches = timingSafeEqual(expectedTokenBytes, candidateTokenBytes);

  const expectedInstanceDigest = createHash('sha256')
    .update(expectedInstanceId)
    .digest();
  const candidateInstanceDigest = createHash('sha256')
    .update(candidateInstanceId)
    .digest();
  const instanceMatches = timingSafeEqual(
    expectedInstanceDigest,
    candidateInstanceDigest,
  );

  return tokenMatches && instanceMatches;
}

function decodeExpectedToken(value: string): Buffer {
  const parsed = AuthTokenSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Stored IPC credentials are invalid.');
  }

  const bytes = Buffer.from(parsed.data, 'base64url');
  if (bytes.byteLength !== PROTOCOL_LIMITS.authTokenBytes) {
    throw new Error('Stored IPC credentials have an invalid byte length.');
  }
  return bytes;
}

function decodeCandidateToken(value: string): Buffer {
  const parsed = AuthTokenSchema.safeParse(value);
  if (!parsed.success) {
    return Buffer.alloc(PROTOCOL_LIMITS.authTokenBytes);
  }

  const bytes = Buffer.from(parsed.data, 'base64url');
  return bytes.byteLength === PROTOCOL_LIMITS.authTokenBytes
    ? bytes
    : Buffer.alloc(PROTOCOL_LIMITS.authTokenBytes);
}
