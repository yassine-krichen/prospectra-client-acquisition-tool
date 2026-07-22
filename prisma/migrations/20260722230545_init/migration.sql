-- CreateEnum
CREATE TYPE "Industry" AS ENUM ('local_service', 'saas', 'ecommerce', 'agency', 'other');

-- CreateEnum
CREATE TYPE "CompanySize" AS ENUM ('1-10', '11-50', '51-200', '201+', 'unknown');

-- CreateEnum
CREATE TYPE "ProspectSource" AS ENUM ('google_places', 'builtwith', 'product_hunt', 'crunchbase', 'github', 'indiehackers', 'manual');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('outdated_site', 'no_https', 'old_stack', 'new_launch', 'funding_event', 'hiring_post', 'no_website', 'technical_debt');

-- CreateEnum
CREATE TYPE "SignalStrength" AS ENUM ('weak', 'medium', 'strong');

-- CreateEnum
CREATE TYPE "ProjectFit" AS ENUM ('landing_page', 'full_stack_app', 'backend_api', 'unclear');

-- CreateEnum
CREATE TYPE "EstimatedBudget" AS ENUM ('low', 'mid', 'high', 'unknown');

-- CreateEnum
CREATE TYPE "ProspectStatus" AS ENUM ('new', 'enriched', 'drafted', 'queued', 'sent', 'followup_1', 'followup_2', 'followup_3', 'replied', 'won', 'dead', 'unsubscribed');

-- CreateEnum
CREATE TYPE "ReplySentiment" AS ENUM ('positive', 'neutral', 'negative');

-- CreateEnum
CREATE TYPE "ModelUsed" AS ENUM ('gemini', 'groq', 'claude-bridge');

-- CreateTable
CREATE TABLE "Prospect" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "companyName" TEXT NOT NULL,
    "domain" TEXT,
    "websiteUrl" TEXT,
    "industry" "Industry" NOT NULL,
    "location" JSONB NOT NULL,
    "companySize" "CompanySize" NOT NULL,
    "contactName" TEXT,
    "contactTitle" TEXT,
    "contactEmail" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "emailConfidence" INTEGER NOT NULL,
    "linkedinUrl" TEXT,
    "source" "ProspectSource" NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "discoveredAt" TIMESTAMP(3) NOT NULL,
    "signal" JSONB NOT NULL,
    "projectFit" "ProjectFit" NOT NULL,
    "estimatedBudget" "EstimatedBudget" NOT NULL,
    "priorityScore" INTEGER NOT NULL,
    "status" "ProspectStatus" NOT NULL DEFAULT 'new',
    "statusHistory" JSONB NOT NULL DEFAULT '[]',
    "activeDraftId" TEXT,
    "sentAt" TIMESTAMP(3),
    "lastFollowupAt" TIMESTAMP(3),
    "followupCount" INTEGER NOT NULL DEFAULT 0,
    "repliedAt" TIMESTAMP(3),
    "replySentiment" "ReplySentiment",
    "doNotContact" BOOLEAN NOT NULL DEFAULT false,
    "unsubscribedAt" TIMESTAMP(3),
    "notes" TEXT,
    "tags" TEXT[],

    CONSTRAINT "Prospect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "variant" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "humanizedBody" TEXT,
    "modelUsed" "ModelUsed" NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "approved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Draft_prospectId_idx" ON "Draft"("prospectId");

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
