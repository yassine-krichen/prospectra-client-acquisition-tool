-- AlterTable
ALTER TABLE "Prospect" ADD COLUMN     "lastDraftFailure" JSONB;

-- AlterTable
ALTER TABLE "Draft" ADD COLUMN     "lastSendFailure" JSONB;
