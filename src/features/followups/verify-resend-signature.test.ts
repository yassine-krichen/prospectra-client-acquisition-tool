import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

// `verify-resend-signature.ts` reads `env.RESEND_WEBHOOK_SECRET` at call time
// from the `env` module-level singleton, which is itself computed once at
// import time from `process.env` (see env.ts). So - same pattern as
// env.test.ts - every case that needs a specific RESEND_WEBHOOK_SECRET value
// mutates `process.env` and forces a fresh module evaluation via
// `vi.resetModules()` + a dynamic import, rather than mocking the module.

const BASE_ENV = {
  DATABASE_URL: 'postgresql://user:pass@example.neon.tech/biz_scraper?sslmode=require',
  SESSION_SECRET: 'test-session-secret-32-characters',
  CRON_SECRET: 'test-cron-secret-32-characters-long',
};

const originalEnv = { ...process.env };

function setEnv(overrides: Record<string, string | undefined>): void {
  const merged = { ...BASE_ENV, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function loadVerifyModule(): Promise<typeof import('./verify-resend-signature')> {
  vi.resetModules();
  return import('./verify-resend-signature');
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

// Independently computes the signature Resend/Svix would send, using Node's
// own crypto module rather than reusing any code path from
// verify-resend-signature.ts - a shared bug between "how the test builds a
// valid signature" and "how the source verifies it" would otherwise let a
// broken verifier pass its own tests.
function computeValidSignature(whsecSecret: string, signedContent: string): string {
  const withoutPrefix = whsecSecret.startsWith('whsec_') ? whsecSecret.slice('whsec_'.length) : whsecSecret;
  const keyBytes = Buffer.from(withoutPrefix, 'base64');
  return createHmac('sha256', keyBytes).update(signedContent).digest('base64');
}

const WEBHOOK_SECRET = `whsec_${Buffer.from('a-known-32-byte-secret-material!').toString('base64')}`;

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

interface ValidRequest {
  rawBody: string;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
}

function buildValidRequest(overrides: Partial<{ rawBody: string; svixId: string; svixTimestamp: string }> = {}): ValidRequest {
  const rawBody = overrides.rawBody ?? JSON.stringify({ type: 'email.received', data: { from: 'a@b.com' } });
  const svixId = overrides.svixId ?? 'msg_test123';
  const svixTimestamp = overrides.svixTimestamp ?? nowSeconds();
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const signature = computeValidSignature(WEBHOOK_SECRET, signedContent);

  return { rawBody, svixId, svixTimestamp, svixSignature: `v1,${signature}` };
}

describe('verifyResendWebhookSignature valid signature', () => {
  it('verifies true for a correctly signed request with the matching secret configured', async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { verifyResendWebhookSignature } = await loadVerifyModule();
    const request = buildValidRequest();

    const result = await verifyResendWebhookSignature(request.rawBody, {
      svixId: request.svixId,
      svixTimestamp: request.svixTimestamp,
      svixSignature: request.svixSignature,
    });

    expect(result).toBe(true);
  });

  it('verifies true when svix-signature carries multiple rotation entries and any one of them matches', async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { verifyResendWebhookSignature } = await loadVerifyModule();
    const request = buildValidRequest();
    const rotatedSignatureHeader = `v1,not-the-right-signature-at-all== ${request.svixSignature}`;

    const result = await verifyResendWebhookSignature(request.rawBody, {
      svixId: request.svixId,
      svixTimestamp: request.svixTimestamp,
      svixSignature: rotatedSignatureHeader,
    });

    expect(result).toBe(true);
  });
});

describe('verifyResendWebhookSignature tampering fails closed', () => {
  it('rejects a tampered request body even though the signature header is untouched', async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { verifyResendWebhookSignature } = await loadVerifyModule();
    const request = buildValidRequest();

    const result = await verifyResendWebhookSignature('{"type":"email.received","data":{"from":"tampered@evil.com"}}', {
      svixId: request.svixId,
      svixTimestamp: request.svixTimestamp,
      svixSignature: request.svixSignature,
    });

    expect(result).toBe(false);
  });

  it('rejects a request whose svix-timestamp header was changed after signing, even to another fresh timestamp', async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { verifyResendWebhookSignature } = await loadVerifyModule();
    const request = buildValidRequest();
    const tamperedTimestamp = String(Number(request.svixTimestamp) + 10);

    const result = await verifyResendWebhookSignature(request.rawBody, {
      svixId: request.svixId,
      svixTimestamp: tamperedTimestamp,
      svixSignature: request.svixSignature,
    });

    expect(result).toBe(false);
  });

  it('rejects a request whose svix-signature header was flipped by a single character', async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { verifyResendWebhookSignature } = await loadVerifyModule();
    const request = buildValidRequest();
    const [, sigValue] = request.svixSignature.split(',');
    const flipped = sigValue[0] === 'A' ? 'B' : 'A';
    const tamperedSignature = `v1,${flipped}${sigValue.slice(1)}`;

    const result = await verifyResendWebhookSignature(request.rawBody, {
      svixId: request.svixId,
      svixTimestamp: request.svixTimestamp,
      svixSignature: tamperedSignature,
    });

    expect(result).toBe(false);
  });

  it('rejects a signature with only a non-"v1" version entry, since no v1 entry can match', async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { verifyResendWebhookSignature } = await loadVerifyModule();
    const request = buildValidRequest();
    const [, sigValue] = request.svixSignature.split(',');

    const result = await verifyResendWebhookSignature(request.rawBody, {
      svixId: request.svixId,
      svixTimestamp: request.svixTimestamp,
      svixSignature: `v2,${sigValue}`,
    });

    expect(result).toBe(false);
  });
});

describe('verifyResendWebhookSignature - RESEND_WEBHOOK_SECRET unset fails closed (critical case)', () => {
  it('rejects a genuinely valid, correctly signed request when RESEND_WEBHOOK_SECRET is unset at verification time', async () => {
    // Build a real, well-formed signature using the known secret first - this
    // is the exact request Resend would send if RESEND_WEBHOOK_SECRET really
    // were configured to WEBHOOK_SECRET.
    setEnv({ RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const signingModule = await loadVerifyModule();
    const request = buildValidRequest();
    // Sanity check: this exact request does verify when the secret matches.
    await expect(
      signingModule.verifyResendWebhookSignature(request.rawBody, {
        svixId: request.svixId,
        svixTimestamp: request.svixTimestamp,
        svixSignature: request.svixSignature,
      })
    ).resolves.toBe(true);

    // Now reload with RESEND_WEBHOOK_SECRET unset and replay the exact same,
    // otherwise-valid request. Fail-closed means this must be rejected - an
    // unset secret means the server can't verify anything, not that it
    // trusts whatever arrives.
    setEnv({ RESEND_WEBHOOK_SECRET: undefined });
    const unconfiguredModule = await loadVerifyModule();

    const result = await unconfiguredModule.verifyResendWebhookSignature(request.rawBody, {
      svixId: request.svixId,
      svixTimestamp: request.svixTimestamp,
      svixSignature: request.svixSignature,
    });

    expect(result).toBe(false);
  });
});

describe('verifyResendWebhookSignature malformed/missing headers fail closed without throwing', () => {
  it('rejects and does not throw when svix-id is missing', async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { verifyResendWebhookSignature } = await loadVerifyModule();
    const request = buildValidRequest();

    await expect(
      verifyResendWebhookSignature(request.rawBody, {
        svixId: null,
        svixTimestamp: request.svixTimestamp,
        svixSignature: request.svixSignature,
      })
    ).resolves.toBe(false);
  });

  it('rejects and does not throw when svix-timestamp is missing', async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { verifyResendWebhookSignature } = await loadVerifyModule();
    const request = buildValidRequest();

    await expect(
      verifyResendWebhookSignature(request.rawBody, {
        svixId: request.svixId,
        svixTimestamp: null,
        svixSignature: request.svixSignature,
      })
    ).resolves.toBe(false);
  });

  it('rejects and does not throw when svix-signature is missing', async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { verifyResendWebhookSignature } = await loadVerifyModule();
    const request = buildValidRequest();

    await expect(
      verifyResendWebhookSignature(request.rawBody, {
        svixId: request.svixId,
        svixTimestamp: request.svixTimestamp,
        svixSignature: null,
      })
    ).resolves.toBe(false);
  });

  it('rejects a timestamp more than 5 minutes in the past, even with an otherwise-correct signature for that stale timestamp', async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { verifyResendWebhookSignature } = await loadVerifyModule();
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const rawBody = JSON.stringify({ type: 'email.received', data: { from: 'a@b.com' } });
    const svixId = 'msg_stale';
    const signature = computeValidSignature(WEBHOOK_SECRET, `${svixId}.${staleTimestamp}.${rawBody}`);

    const result = await verifyResendWebhookSignature(rawBody, {
      svixId,
      svixTimestamp: staleTimestamp,
      svixSignature: `v1,${signature}`,
    });

    expect(result).toBe(false);
  });

  it('rejects a timestamp more than 5 minutes in the future, even with an otherwise-correct signature for that timestamp', async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { verifyResendWebhookSignature } = await loadVerifyModule();
    const futureTimestamp = String(Math.floor(Date.now() / 1000) + 6 * 60);
    const rawBody = JSON.stringify({ type: 'email.received', data: { from: 'a@b.com' } });
    const svixId = 'msg_future';
    const signature = computeValidSignature(WEBHOOK_SECRET, `${svixId}.${futureTimestamp}.${rawBody}`);

    const result = await verifyResendWebhookSignature(rawBody, {
      svixId,
      svixTimestamp: futureTimestamp,
      svixSignature: `v1,${signature}`,
    });

    expect(result).toBe(false);
  });

  it('rejects (without throwing) a non-numeric svix-timestamp', async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { verifyResendWebhookSignature } = await loadVerifyModule();
    const request = buildValidRequest();

    await expect(
      verifyResendWebhookSignature(request.rawBody, {
        svixId: request.svixId,
        svixTimestamp: 'not-a-number',
        svixSignature: request.svixSignature,
      })
    ).resolves.toBe(false);
  });

  it('rejects (without throwing) when RESEND_WEBHOOK_SECRET is configured but is not valid base64', async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: 'whsec_%%%not-base64%%%' });
    const { verifyResendWebhookSignature } = await loadVerifyModule();
    const request = buildValidRequest();

    await expect(
      verifyResendWebhookSignature(request.rawBody, {
        svixId: request.svixId,
        svixTimestamp: request.svixTimestamp,
        svixSignature: request.svixSignature,
      })
    ).resolves.toBe(false);
  });
});
