-- AlterTable
ALTER TABLE "Draft" ADD COLUMN     "framework" TEXT;

-- CreateTable
CREATE TABLE "BridgeCooldown" (
    "source" TEXT NOT NULL,
    "blockedUntil" TIMESTAMP(3),

    CONSTRAINT "BridgeCooldown_pkey" PRIMARY KEY ("source")
);
