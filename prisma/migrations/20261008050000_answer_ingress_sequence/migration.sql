-- The inbox position of the inbound event behind the current revision of an answer: with equal
-- provider timestamps, replies are ordered by arrival instead of by a receipt time that one
-- webhook batch shares. Existing answers take the position of their current revision's event.
ALTER TABLE "answers" ADD COLUMN "current_ingress_sequence" BIGINT;

UPDATE "answers" AS a
SET "current_ingress_sequence" = e."ingress_sequence"
FROM "answer_revisions" AS r
JOIN "inbound_events" AS e ON e."id" = r."inbound_event_id"
WHERE r."answer_id" = a."id"
  AND r."is_current" = true;
