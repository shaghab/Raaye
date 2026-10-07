-- Per-row application marker so an interrupted import resumes exactly once per row.
ALTER TABLE "import_rows" ADD COLUMN "applied_at" TIMESTAMPTZ(6);
