-- CreateTable
CREATE TABLE "ProspectComment" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorNickname" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProspectComment_prospectId_idx" ON "ProspectComment"("prospectId");

-- AddForeignKey
ALTER TABLE "ProspectComment" ADD CONSTRAINT "ProspectComment_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
