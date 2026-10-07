-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "pushed_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "jobs_status_pushed_at_due_at_idx" ON "jobs"("status", "pushed_at", "due_at");
