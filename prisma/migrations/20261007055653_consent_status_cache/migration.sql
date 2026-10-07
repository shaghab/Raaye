-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('UNKNOWN', 'GRANTED', 'WITHDRAWN');

-- AlterEnum
ALTER TYPE "ConsentEventType" ADD VALUE 'RESET';

-- AlterEnum
ALTER TYPE "ConsentSource" ADD VALUE 'PHONE_CHANGED';

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "consent_invitations" "ConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "consent_invitations_at" TIMESTAMPTZ(6),
ADD COLUMN     "consent_results" "ConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "consent_results_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "contacts_organization_id_consent_invitations_archived_at_idx" ON "contacts"("organization_id", "consent_invitations", "archived_at");
