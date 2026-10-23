import { FollowupApprovalTable } from '@/features/followups/followup-approval-table';
import { ApprovalQueueTable } from '@/features/sending/approval-queue-table';

export default function QueuePage(): React.JSX.Element {
  return (
    <>
      <ApprovalQueueTable />
      <FollowupApprovalTable />
    </>
  );
}
