-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ProspectSource" ADD VALUE 'overpass';
ALTER TYPE "ProspectSource" ADD VALUE 'yellowpages';
ALTER TYPE "ProspectSource" ADD VALUE 'companies_house';
ALTER TYPE "ProspectSource" ADD VALUE 'texas_comptroller';

-- AlterEnum
ALTER TYPE "SignalType" ADD VALUE 'recently_registered';
