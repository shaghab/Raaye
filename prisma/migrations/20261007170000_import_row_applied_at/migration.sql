-- Per-row application marker so an interrupted import resumes exactly once per row.
ALTER TABLE "import_rows" ADD COLUMN "applied_at" TIMESTAMPTZ(6);

-- Rows that earlier processing already applied, before the marker existed, must never be applied
-- again when a batch that was in flight during the upgrade is resumed.
-- 1. A completed batch processed every planned row: stamp all of them.
UPDATE "import_rows" r
SET "applied_at" = COALESCE(b."completed_at", b."confirmed_at", b."updated_at")
FROM "import_batches" b
WHERE r."batch_id" = b."id" AND b."state" = 'COMPLETED' AND r."status" IN ('CREATE', 'UPDATE');

-- 2. In an in-flight batch, a planned CREATE only carries a contact once it was created.
UPDATE "import_rows" r
SET "applied_at" = COALESCE(b."completed_at", b."confirmed_at", b."updated_at")
FROM "import_batches" b
WHERE r."batch_id" = b."id" AND b."state" IN ('CONFIRMED', 'FAILED')
  AND r."status" = 'CREATE' AND r."contact_id" IS NOT NULL;

-- 3. An applied UPDATE left durable evidence: the batch is the contact's last import, or the batch
--    recorded consent evidence for the contact.
UPDATE "import_rows" r
SET "applied_at" = COALESCE(b."completed_at", b."confirmed_at", b."updated_at")
FROM "import_batches" b
WHERE r."batch_id" = b."id" AND b."state" IN ('CONFIRMED', 'FAILED') AND r."status" = 'UPDATE' AND r."contact_id" IS NOT NULL
  AND (
    EXISTS (SELECT 1 FROM "contacts" c WHERE c."id" = r."contact_id" AND c."import_batch_id" = r."batch_id")
    OR EXISTS (SELECT 1 FROM "consent_events" e WHERE e."contact_id" = r."contact_id" AND e."import_batch_id" = r."batch_id")
  );

-- 4. The remaining UPDATE rows of in-flight batches cannot be classified (a later import may have
--    overwritten the evidence): refuse them instead of replaying stale values or consent evidence.
UPDATE "import_rows" r
SET "status" = 'ERROR',
    "applied_at" = COALESCE(b."confirmed_at", b."updated_at"),
    "errors" = jsonb_build_array(jsonb_build_object('rowNumber', r."row_number", 'field', NULL, 'message', 'Whether this row was applied before the upgrade cannot be determined: re-import the file to apply it'))
FROM "import_batches" b
WHERE r."batch_id" = b."id" AND b."state" IN ('CONFIRMED', 'FAILED') AND r."status" = 'UPDATE' AND r."applied_at" IS NULL;
