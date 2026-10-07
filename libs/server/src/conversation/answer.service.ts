import { Inject, Injectable } from '@nestjs/common';
import type { AnswerSource } from '../persistence/prisma.service';
import { computeEditExpiry, evaluateEdit, evaluateFirstAnswer, isStaleReply, selectionsEqual, validateSelection, type Clock } from '@raaye/domain';
import { CLOCK } from '../clock/clock.service';
import { isUniqueViolation } from '../persistence/db-errors';
import { Prisma } from '../persistence/prisma.service';
import type { TenantTx } from '../persistence/tenant-db';

export interface SubmitAnswerInput {
  organizationId: string;
  participationId: string;
  questionId: string;
  optionIds: string[];
  source: AnswerSource;
  inboundEventId: string | null;
  providerAt: Date | null;
  receivedAt: Date;
}

export type SubmitAnswerResult =
  | { outcome: 'CREATED'; answerId: string; completed: boolean; nextQuestionId: string | null }
  | { outcome: 'EDITED'; answerId: string; completed: boolean }
  | { outcome: 'UNCHANGED'; answerId: string }
  | { outcome: 'REJECTED'; code: 'SURVEY_NOT_OPEN' | 'SURVEY_CLOSED' | 'ANSWER_EDIT_EXPIRED' | 'ANSWER_STALE' | 'QUESTION_OPTION_INVALID' | 'SELECTION_COUNT_INVALID' | 'TENANT_RESOURCE_NOT_FOUND'; message: string };

/**
 * Canonical answer writes. Runs inside the caller's transaction with the participation
 * row locked, so concurrent first replies create one Answer and later replies follow the
 * fixed edit window. Revisions are append-only; aggregates read only current ones.
 */
@Injectable()
export class AnswerService {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async submit(tx: TenantTx, input: SubmitAnswerInput): Promise<SubmitAnswerResult> {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM participations WHERE id = ${input.participationId}::uuid AND organization_id = ${input.organizationId}::uuid FOR UPDATE`);
    const participation = await tx.participation.findUnique({
      where: { id: input.participationId },
      include: { revision: { include: { questions: { include: { options: true }, orderBy: { position: 'asc' } } } } },
    });
    if (!participation) return { outcome: 'REJECTED', code: 'TENANT_RESOURCE_NOT_FOUND', message: 'Participation not found' };
    // Serialize with closure: closeRun updates the run row, so taking its lock here orders this write
    // after any close that already committed, and the state is re-read once the lock is held.
    await tx.$queryRaw(Prisma.sql`SELECT id FROM survey_runs WHERE id = ${participation.runId}::uuid AND organization_id = ${input.organizationId}::uuid FOR UPDATE`);
    const run = await tx.surveyRun.findUniqueOrThrow({ where: { id: participation.runId }, select: { state: true, closesAt: true } });
    const question = participation.revision.questions.find((candidate) => candidate.id === input.questionId);
    if (!question) return { outcome: 'REJECTED', code: 'QUESTION_OPTION_INVALID', message: 'Question does not belong to this survey' };
    const now = this.clock.now();
    const validation = validateSelection(
      { type: question.type, minSelections: question.minSelections, maxSelections: question.maxSelections, options: question.options.map((option) => ({ id: option.id, code: option.code, position: option.position, label: option.label as Record<string, string>, shortLabel: null, ratingValue: option.ratingValue, exclusive: option.exclusive })) },
      input.optionIds,
    );
    if (!validation.ok) return { outcome: 'REJECTED', code: validation.code, message: validation.message };
    const existing = await tx.answer.findUnique({ where: { organizationId_participationId_questionId: { organizationId: input.organizationId, participationId: participation.id, questionId: question.id } }, include: { revisions: { where: { isCurrent: true }, include: { selections: true } } } });
    if (!existing) {
      const decision = evaluateFirstAnswer({ now, runState: run.state, closesAt: run.closesAt });
      if (!decision.allowed) return { outcome: 'REJECTED', code: decision.reason, message: decision.reason };
      const editExpiresAt = computeEditExpiry(now, participation.revision.editWindowSeconds, run.closesAt);
      try {
        const answer = await tx.answer.create({
          data: {
            organizationId: input.organizationId,
            participationId: participation.id,
            revisionId: participation.revisionId,
            questionId: question.id,
            firstAcceptedAt: now,
            editExpiresAt,
            currentRevisionNumber: 1,
            currentProviderAt: input.providerAt,
            currentReceivedAt: input.receivedAt,
          },
        });
        await this.writeRevision(tx, input, answer.id, question.id, 1, now, validation.optionIds, validation.ratingValue);
        const answered = new Set((await tx.answer.findMany({ where: { participationId: participation.id }, select: { questionId: true } })).map((row) => row.questionId));
        const next = participation.revision.questions.find((candidate) => !answered.has(candidate.id)) ?? null;
        const completed = next === null;
        await tx.participation.update({
          where: { id: participation.id },
          data: {
            currentQuestionId: next?.id ?? null,
            state: completed ? 'COMPLETED' : 'STARTED',
            completedAt: completed && !participation.completedAt ? now : participation.completedAt,
            lastInboundAt: input.receivedAt,
          },
        });
        return { outcome: 'CREATED', answerId: answer.id, completed, nextQuestionId: next?.id ?? null };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Lost a race for the first answer inside the lock window; fall through to edit rules.
      }
    }
    const current = existing ?? (await tx.answer.findUniqueOrThrow({ where: { organizationId_participationId_questionId: { organizationId: input.organizationId, participationId: participation.id, questionId: question.id } }, include: { revisions: { where: { isCurrent: true }, include: { selections: true } } } }));
    const currentSelection = current.revisions[0]?.selections.map((selection) => selection.optionId) ?? [];
    if (selectionsEqual(currentSelection, validation.optionIds)) return { outcome: 'UNCHANGED', answerId: current.id };
    if (isStaleReply({ incomingProviderAt: input.providerAt, incomingReceivedAt: input.receivedAt, currentProviderAt: current.currentProviderAt, currentReceivedAt: current.currentReceivedAt })) {
      return { outcome: 'REJECTED', code: 'ANSWER_STALE', message: 'A newer answer is already recorded' };
    }
    const decision = evaluateEdit({ now, runState: run.state, closesAt: run.closesAt, editExpiresAt: current.editExpiresAt });
    if (!decision.allowed) return { outcome: 'REJECTED', code: decision.reason, message: decision.reason };
    const revisionNumber = current.currentRevisionNumber + 1;
    await tx.answerRevision.updateMany({ where: { answerId: current.id, isCurrent: true }, data: { isCurrent: false } });
    await this.writeRevision(tx, input, current.id, question.id, revisionNumber, now, validation.optionIds, validation.ratingValue);
    await tx.answer.update({ where: { id: current.id }, data: { currentRevisionNumber: revisionNumber, currentProviderAt: input.providerAt, currentReceivedAt: input.receivedAt } });
    await tx.participation.update({ where: { id: participation.id }, data: { lastInboundAt: input.receivedAt } });
    return { outcome: 'EDITED', answerId: current.id, completed: participation.state === 'COMPLETED' };
  }

  private async writeRevision(tx: TenantTx, input: SubmitAnswerInput, answerId: string, questionId: string, revisionNumber: number, acceptedAt: Date, optionIds: string[], ratingValue: number | null): Promise<void> {
    const revision = await tx.answerRevision.create({
      data: {
        organizationId: input.organizationId,
        answerId,
        questionId,
        revisionNumber,
        acceptedAt,
        providerAt: input.providerAt,
        receivedAt: input.receivedAt,
        inboundEventId: input.inboundEventId,
        source: input.source,
        ratingValue,
        isCurrent: true,
      },
    });
    await tx.answerSelection.createMany({ data: optionIds.map((optionId) => ({ organizationId: input.organizationId, answerRevisionId: revision.id, questionId, optionId })) });
  }
}
