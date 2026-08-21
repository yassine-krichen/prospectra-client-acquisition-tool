-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('landing_page', 'full_stack_app', 'linkedin_media_management', 'infra_hosting_retainer');

-- CreateEnum
CREATE TYPE "JobCadence" AS ENUM ('one_off', 'recurring');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('active', 'delivered', 'monthly', 'cancelled');

-- CreateEnum
CREATE TYPE "RetainerDiscount" AS ENUM ('free', 'half_price');

-- AlterTable
ALTER TABLE "Prospect" ADD COLUMN     "suggestedServices" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "prospectId" TEXT,
    "companyName" TEXT NOT NULL,
    "domain" TEXT,
    "contactName" TEXT,
    "contactTitle" TEXT,
    "contactEmail" TEXT,
    "industry" "Industry" NOT NULL,
    "companySize" "CompanySize" NOT NULL,
    "doNotContact" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "statusHistory" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "service" "ServiceType" NOT NULL,
    "cadence" "JobCadence" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'active',
    "agreedPriceCents" INTEGER NOT NULL,
    "soldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "freeRevisionRoundsUsed" INTEGER NOT NULL DEFAULT 0,
    "freeRevisionWindowEndsAt" TIMESTAMP(3),
    "retainerDiscount" "RetainerDiscount",
    "retainerDiscountEndsAt" TIMESTAMP(3),
    "lastRetentionTouchAt" TIMESTAMP(3),
    "retentionTouchCount" INTEGER NOT NULL DEFAULT 0,
    "statusHistory" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_prospectId_key" ON "Client"("prospectId");

-- CreateIndex
CREATE INDEX "Job_clientId_idx" ON "Job"("clientId");

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
