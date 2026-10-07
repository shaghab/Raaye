-- Operator bootstrap invitations have no inviting user.
ALTER TABLE "staff_invitations" ALTER COLUMN "invited_by_user_id" DROP NOT NULL;
