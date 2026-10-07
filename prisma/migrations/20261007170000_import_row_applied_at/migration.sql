-- Per-row application marker so an interrupted import resumes exactly once per row.
ALTER TABLE "import_rows" ADD COLUMN "applied_at" TIMESTAMPTZ(6);

-- Rows that earlier processing already applied, before the marker existed: a planned CREATE only
-- carries a contact once it was created, and an applied UPDATE left the batch as the contact's last
-- import. Stamping them keeps a resume of a batch that was in flight during the upgrade idempotent.
UPDATE "import_rows" r
SET "applied_at" = COALESCE(b."completed_at", b."confirmed_at", b."updated_at")
FROM "import_batches" b
WHERE r."batch_id" = b."id" AND b."state" IN ('CONFIRMED', 'COMPLETED', 'FAILED')
  AND r."status" = 'CREATE' AND r."contact_id" IS NOT NULL;

UPDATE "import_rows" r
SET "applied_at" = COALESCE(b."completed_at", b."confirmed_at", b."updated_at")
FROM "import_batches" b, "contacts" c
WHERE r."batch_id" = b."id" AND b."state" IN ('CONFIRMED', 'COMPLETED', 'FAILED')
  AND r."status" = 'UPDATE' AND c."id" = r."contact_id" AND c."import_batch_id" = r."batch_id";
