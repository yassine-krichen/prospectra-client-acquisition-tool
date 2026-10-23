import { env } from '@/common/config/env';

/**
 * Whether follow-ups (touch 2) need a human approval before they send.
 * Defaults to true; only `FOLLOWUP_APPROVAL_REQUIRED="false"` turns it off
 * (see env.ts). Like the daily-cap gate, this is the single place the
 * decision is read, so no other module touches the env var directly.
 */
export function isFollowupApprovalRequired(): boolean {
  return env.FOLLOWUP_APPROVAL_REQUIRED;
}
