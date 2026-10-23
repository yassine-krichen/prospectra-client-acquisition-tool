import { describe, expect, it } from 'vitest';

import {
  blockingApprovedDrafts,
  getSendLockState,
  hasUnconfirmedSend,
  SEND_IN_FLIGHT_WINDOW_MS,
} from './unconfirmed-send';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function msBefore(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function draft(overrides: { approved?: boolean; generatedAt?: Date; lastSendFailure?: unknown } = {}) {
  return {
    approved: overrides.approved ?? false,
    generatedAt: overrides.generatedAt ?? msBefore(60 * 60 * 1000),
    lastSendFailure: overrides.lastSendFailure ?? null,
  };
}

describe('getSendLockState', () => {
  it('is unconfirmed when the send-unconfirmed tag is present, whatever the drafts say', () => {
    expect(getSendLockState({ tags: ['send-unconfirmed'], sentAt: null, drafts: [] }, NOW)).toBe('unconfirmed');
  });

  it('is none when no draft is approved and there is no tag', () => {
    expect(getSendLockState({ tags: [], sentAt: null, drafts: [draft()] }, NOW)).toBe('none');
  });

  it('is unconfirmed for an approved draft that recorded an unconfirmed failure', () => {
    const failed = draft({ approved: true, lastSendFailure: { reason: 'timeout', occurredAt: NOW.toISOString(), unconfirmed: true } });

    expect(getSendLockState({ tags: [], sentAt: null, drafts: [failed] }, NOW)).toBe('unconfirmed');
  });

  it('is sending for an approved draft whose attempt started within the in-flight window', () => {
    const running = draft({
      approved: true,
      lastSendFailure: { inFlight: true, startedAt: msBefore(SEND_IN_FLIGHT_WINDOW_MS - 1000).toISOString() },
    });

    expect(getSendLockState({ tags: [], sentAt: null, drafts: [running] }, NOW)).toBe('sending');
  });

  it('is unconfirmed once an in-flight attempt is older than the window, since it was abandoned', () => {
    const abandoned = draft({
      approved: true,
      lastSendFailure: { inFlight: true, startedAt: msBefore(SEND_IN_FLIGHT_WINDOW_MS + 1000).toISOString() },
    });

    expect(getSendLockState({ tags: [], sentAt: null, drafts: [abandoned] }, NOW)).toBe('unconfirmed');
  });

  it('is unconfirmed for an approved draft with no attempt record at all (claimed before attempts were recorded)', () => {
    expect(getSendLockState({ tags: [], sentAt: null, drafts: [draft({ approved: true })] }, NOW)).toBe('unconfirmed');
  });

  it('does not treat an unreadable in-flight marker as a running send', () => {
    const garbled = draft({ approved: true, lastSendFailure: { inFlight: true, startedAt: 'not-a-date' } });

    expect(getSendLockState({ tags: [], sentAt: null, drafts: [garbled] }, NOW)).toBe('unconfirmed');
  });

  it('ignores an approved draft that predates the recorded send (stale after a re-draft)', () => {
    const sentAt = msBefore(24 * 60 * 60 * 1000);
    const stale = draft({ approved: true, generatedAt: new Date(sentAt.getTime() - 1000) });

    expect(getSendLockState({ tags: [], sentAt, drafts: [stale] }, NOW)).toBe('none');
  });

  it('locks on an approved draft generated after the recorded send (a new variant of a re-drafted prospect)', () => {
    const sentAt = msBefore(24 * 60 * 60 * 1000);
    const fresh = draft({ approved: true, generatedAt: msBefore(60 * 60 * 1000) });

    expect(getSendLockState({ tags: [], sentAt, drafts: [fresh] }, NOW)).toBe('unconfirmed');
  });
});

describe('getSendLockState tie at the send time', () => {
  it('blocks on an approved draft generated at exactly the recorded send time', () => {
    const sentAt = msBefore(60 * 60 * 1000);
    const tied = draft({ approved: true, generatedAt: new Date(sentAt.getTime()) });

    expect(getSendLockState({ tags: [], sentAt, drafts: [tied] }, NOW)).toBe('unconfirmed');
  });
});

describe('hasUnconfirmedSend', () => {
  it('is true only for the unconfirmed state, not while a send is still running', () => {
    const running = draft({ approved: true, lastSendFailure: { inFlight: true, startedAt: msBefore(1000).toISOString() } });

    expect(hasUnconfirmedSend({ tags: [], sentAt: null, drafts: [running] }, NOW)).toBe(false);
    expect(hasUnconfirmedSend({ tags: ['send-unconfirmed'], sentAt: null, drafts: [] }, NOW)).toBe(true);
  });
});

describe('blockingApprovedDrafts', () => {
  it('keeps every approved draft when nothing was ever sent', () => {
    const drafts = [draft({ approved: true }), draft({ approved: false })];

    expect(blockingApprovedDrafts(null, drafts)).toHaveLength(1);
  });
});
