-- CreateTable
CREATE TABLE "LoginLockout" (
    "nickname" TEXT NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "LoginLockout_pkey" PRIMARY KEY ("nickname")
);
