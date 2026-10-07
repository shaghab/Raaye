-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'SURVEY_MANAGER', 'VIEWER');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "UserState" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('WOMAN', 'MAN', 'ANOTHER_IDENTITY', 'PREFER_NOT_TO_SAY');

-- CreateEnum
CREATE TYPE "AgeBand" AS ENUM ('UNDER_18', 'AGE_18_24', 'AGE_25_34', 'AGE_35_44', 'AGE_45_54', 'AGE_55_64', 'AGE_65_PLUS', 'PREFER_NOT_TO_SAY');

-- CreateEnum
CREATE TYPE "MembershipKind" AS ENUM ('MEMBER', 'NON_MEMBER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ValueSource" AS ENUM ('ADMIN', 'IMPORT', 'SELF_REPORTED');

-- CreateEnum
CREATE TYPE "ConsentScope" AS ENUM ('SURVEY_INVITATIONS', 'SURVEY_RESULTS');

-- CreateEnum
CREATE TYPE "ConsentEventType" AS ENUM ('GRANTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('STAFF_RECORDED', 'IMPORT_ATTESTATION', 'PARTICIPANT_REPLY', 'PARTICIPANT_STOP', 'STAFF_OPT_OUT', 'SEED');

-- CreateEnum
CREATE TYPE "EnrollmentState" AS ENUM ('AWAITING_NAME', 'AWAITING_CONSENT', 'COMPLETED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SurveyState" AS ENUM ('DRAFT', 'SCHEDULED', 'ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('SINGLE_CHOICE', 'MULTI_CHOICE', 'RATING');

-- CreateEnum
CREATE TYPE "QuestionPreset" AS ENUM ('YES_NO', 'YES_NO_INDIFFERENT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "RunKind" AS ENUM ('LIVE', 'TEST');

-- CreateEnum
CREATE TYPE "RunState" AS ENUM ('SCHEDULED', 'ACTIVE', 'CLOSED', 'CANCELED');

-- CreateEnum
CREATE TYPE "InvitationState" AS ENUM ('PENDING', 'QUEUED', 'ACCEPTED', 'FAILED', 'UNKNOWN', 'SUPPRESSED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ParticipationState" AS ENUM ('STARTED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ProfileOfferState" AS ENUM ('NOT_OFFERED', 'OFFERED', 'COMPLETED', 'SKIPPED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "AnswerSource" AS ENUM ('BUTTON', 'LIST', 'FLOW', 'TEMPLATE_BUTTON', 'TEXT_FALLBACK');

-- CreateEnum
CREATE TYPE "ActionPurpose" AS ENUM ('START_SURVEY', 'CONTINUE_SURVEY', 'SWITCH_SURVEY', 'ANSWER_OPTION', 'QUESTION_FLOW', 'EDIT_QUESTION', 'PROFILE_OFFER_ACCEPT', 'PROFILE_OFFER_SKIP', 'PROFILE_FLOW', 'CONSENT_ACCEPT', 'CONSENT_DECLINE', 'VIEW_RESULTS', 'MENU_SELECT');

-- CreateEnum
CREATE TYPE "ActionMode" AS ENUM ('LIVE', 'TEST');

-- CreateEnum
CREATE TYPE "MessagingProvider" AS ENUM ('MOCK', 'META');

-- CreateEnum
CREATE TYPE "ConnectionMode" AS ENUM ('MOCK', 'LIVE');

-- CreateEnum
CREATE TYPE "TemplatePurpose" AS ENUM ('SURVEY_INVITATION', 'RESULTS_AVAILABLE');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FlowPurpose" AS ENUM ('SINGLE_CHOICE', 'MULTI_CHOICE', 'PROFILE');

-- CreateEnum
CREATE TYPE "FlowStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'DEPRECATED', 'MISSING', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('INVITATION', 'QUESTION', 'ACKNOWLEDGEMENT', 'COMMAND_REPLY', 'OPT_OUT_ACK', 'PROFILE_OFFER', 'PROFILE_FLOW', 'RESULTS_INVITATION', 'RESULTS_CONTENT', 'ENROLLMENT');

-- CreateEnum
CREATE TYPE "MessageState" AS ENUM ('PENDING', 'SENDING', 'ACCEPTED', 'FAILED', 'UNKNOWN', 'SUPPRESSED', 'CANCELED');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('QUEUED', 'ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'UNKNOWN', 'SUPPRESSED', 'CANCELED');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('IN_FLIGHT', 'ACCEPTED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "InboundKind" AS ENUM ('TEXT', 'BUTTON_REPLY', 'LIST_REPLY', 'TEMPLATE_BUTTON', 'FLOW_REPLY', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "InboundProcessingState" AS ENUM ('PENDING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('ACTIVATE_SURVEY', 'CLOSE_SURVEY', 'SEND_INVITATION', 'PROCESS_INBOUND', 'SEND_QUESTION', 'SEND_ACKNOWLEDGEMENT', 'SEND_MESSAGE', 'SEND_RESULTS_INVITATION', 'SEND_RESULTS_CONTENT', 'SWEEP_DUE_WORK', 'CLEANUP_RETENTION');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "SnapshotBroadcastState" AS ENUM ('PENDING', 'QUEUED', 'COMPLETED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ResultAccessState" AS ENUM ('PENDING', 'INVITED', 'VIEWED', 'SUPPRESSED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'PARTICIPANT');

-- CreateEnum
CREATE TYPE "ImportFileType" AS ENUM ('CSV', 'XLSX');

-- CreateEnum
CREATE TYPE "DuplicateMode" AS ENUM ('SKIP_EXISTING', 'UPDATE_NON_EMPTY_FIELDS');

-- CreateEnum
CREATE TYPE "ImportState" AS ENUM ('UPLOADED', 'PREVIEWED', 'CONFIRMED', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('CREATE', 'UPDATE', 'SKIP', 'ERROR');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Karachi',
    "default_locale" TEXT NOT NULL DEFAULT 'en',
    "privacy_url" TEXT,
    "support_contact" TEXT,
    "participant_notice" TEXT NOT NULL,
    "participant_notice_version" INTEGER NOT NULL DEFAULT 1,
    "profile_onboarding_enabled" BOOLEAN NOT NULL DEFAULT true,
    "default_duration_seconds" INTEGER NOT NULL DEFAULT 172800,
    "default_edit_window_seconds" INTEGER NOT NULL DEFAULT 120,
    "live_policy_reviewed_at" TIMESTAMPTZ(6),
    "live_policy_reviewed_by_id" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "firebase_uid" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT,
    "state" "UserState" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_memberships" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_by_user_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "invited_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "provider_identity" TEXT,
    "city" TEXT,
    "city_normalized" TEXT,
    "district" TEXT,
    "district_normalized" TEXT,
    "gender" "Gender",
    "age_band" "AgeBand",
    "age_years" INTEGER,
    "age_as_of" DATE,
    "occupation" TEXT,
    "membership" "MembershipKind" NOT NULL DEFAULT 'UNKNOWN',
    "membership_source" "ValueSource",
    "self_reported_membership" "MembershipKind",
    "self_reported_membership_at" TIMESTAMPTZ(6),
    "profile_provenance" JSONB,
    "preferred_locale" TEXT NOT NULL DEFAULT 'en',
    "is_synthetic" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID,
    "import_batch_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "scope" "ConsentScope" NOT NULL,
    "type" "ConsentEventType" NOT NULL,
    "source" "ConsentSource" NOT NULL,
    "evidence_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "wording_version" TEXT,
    "evidence_reference" TEXT,
    "actor_user_id" UUID,
    "import_batch_id" UUID,
    "note" TEXT,

    CONSTRAINT "consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_groups" (
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_groups_pkey" PRIMARY KEY ("organization_id","contact_id","group_id")
);

-- CreateTable
CREATE TABLE "contact_tags" (
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_tags_pkey" PRIMARY KEY ("organization_id","contact_id","tag_id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "sender_identity" TEXT NOT NULL,
    "state" "EnrollmentState" NOT NULL,
    "proposed_name" TEXT,
    "profile_display_name" TEXT,
    "notice_version" INTEGER NOT NULL,
    "last_inbound_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "surveys" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "internal_title" TEXT NOT NULL,
    "state" "SurveyState" NOT NULL DEFAULT 'DRAFT',
    "current_revision_number" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(6),
    "author_user_id" UUID,
    "cloned_from_survey_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_revisions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "frozen_at" TIMESTAMPTZ(6),
    "locale" TEXT NOT NULL DEFAULT 'en',
    "title" JSONB NOT NULL,
    "introduction" JSONB NOT NULL,
    "edit_window_seconds" INTEGER NOT NULL,
    "duration_seconds" INTEGER NOT NULL,
    "explicit_closes_at" TIMESTAMPTZ(6),
    "scheduled_opens_at" TIMESTAMPTZ(6),
    "audience_definition" JSONB NOT NULL,
    "renderer_plan" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "survey_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "QuestionType" NOT NULL,
    "preset" "QuestionPreset" NOT NULL DEFAULT 'CUSTOM',
    "prompt" JSONB NOT NULL,
    "min_selections" INTEGER,
    "max_selections" INTEGER,
    "rating_min_label" JSONB,
    "rating_max_label" JSONB,
    "renderer" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_options" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" JSONB NOT NULL,
    "short_label" JSONB,
    "rating_value" INTEGER,
    "exclusive" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "kind" "RunKind" NOT NULL,
    "live_slot" INTEGER,
    "state" "RunState" NOT NULL,
    "opens_at" TIMESTAMPTZ(6) NOT NULL,
    "closes_at" TIMESTAMPTZ(6) NOT NULL,
    "activated_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "close_reason" TEXT,
    "audience_definition" JSONB NOT NULL,
    "audience_summary" JSONB NOT NULL,
    "launch_idempotency_key" TEXT,
    "launched_by_user_id" UUID,
    "dispatch_block_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "survey_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_recipients" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "eligible_at_freeze" BOOLEAN NOT NULL,
    "exclusion_reason" TEXT,
    "audience_snapshot" JSONB NOT NULL,
    "suppressed_at" TIMESTAMPTZ(6),
    "suppressed_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "survey_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "message_id" UUID,
    "action_binding_id" UUID,
    "state" "InvitationState" NOT NULL DEFAULT 'PENDING',
    "state_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "state" "ParticipationState" NOT NULL DEFAULT 'STARTED',
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "completion_acked_at" TIMESTAMPTZ(6),
    "current_question_id" UUID,
    "analysis_profile" JSONB,
    "analysis_profile_at" TIMESTAMPTZ(6),
    "last_inbound_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "participations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "foreground_participation_id" UUID,
    "profile_offer_state" "ProfileOfferState" NOT NULL DEFAULT 'NOT_OFFERED',
    "profile_offered_at" TIMESTAMPTZ(6),
    "last_inbound_at" TIMESTAMPTZ(6),
    "pending_input" TEXT,
    "pending_context" JSONB,
    "control_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "participation_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "first_accepted_at" TIMESTAMPTZ(6) NOT NULL,
    "edit_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "current_revision_number" INTEGER NOT NULL,
    "current_provider_at" TIMESTAMPTZ(6),
    "current_received_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answer_revisions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "answer_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL,
    "provider_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "inbound_event_id" UUID,
    "source" "AnswerSource" NOT NULL,
    "rating_value" INTEGER,
    "is_current" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "answer_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answer_selections" (
    "organization_id" UUID NOT NULL,
    "answer_revision_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,

    CONSTRAINT "answer_selections_pkey" PRIMARY KEY ("organization_id","answer_revision_id","option_id")
);

-- CreateTable
CREATE TABLE "action_bindings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "purpose" "ActionPurpose" NOT NULL,
    "mode" "ActionMode" NOT NULL,
    "connection_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "run_id" UUID,
    "participation_id" UUID,
    "question_id" UUID,
    "option_id" UUID,
    "snapshot_id" UUID,
    "payload" JSONB,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messaging_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" "MessagingProvider" NOT NULL,
    "mode" "ConnectionMode" NOT NULL,
    "app_key" TEXT NOT NULL,
    "phone_number_id" TEXT,
    "waba_id" TEXT,
    "app_id" TEXT,
    "display_phone_number" TEXT,
    "graph_version" TEXT,
    "app_secret_ref" TEXT,
    "access_token_ref" TEXT,
    "verify_token_ref" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "readiness_state" TEXT,
    "readiness_detail" JSONB,
    "last_checked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "messaging_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_bindings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "purpose" "TemplatePurpose" NOT NULL,
    "provider_name" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "category" TEXT,
    "status" "TemplateStatus" NOT NULL DEFAULT 'PENDING',
    "button_position" INTEGER NOT NULL DEFAULT 0,
    "parameter_mapping" JSONB NOT NULL,
    "last_checked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "template_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_bindings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "purpose" "FlowPurpose" NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "asset_version" TEXT NOT NULL,
    "provider_flow_id" TEXT,
    "status" "FlowStatus" NOT NULL DEFAULT 'DRAFT',
    "last_checked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "flow_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "run_id" UUID,
    "participation_id" UUID,
    "snapshot_id" UUID,
    "dedupe_key" TEXT NOT NULL,
    "kind" "MessageKind" NOT NULL,
    "state" "MessageState" NOT NULL DEFAULT 'PENDING',
    "delivery_state" "DeliveryState" NOT NULL DEFAULT 'QUEUED',
    "rendered" JSONB NOT NULL,
    "is_free_form" BOOLEAN NOT NULL DEFAULT true,
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "provider_message_id" TEXT,
    "suppression_reason" TEXT,
    "last_error_code" TEXT,
    "last_status_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_attempts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "outcome" "AttemptOutcome" NOT NULL DEFAULT 'IN_FLIGHT',
    "provider_message_id" TEXT,
    "error_code" TEXT,
    "error_detail" TEXT,
    "retryable" BOOLEAN,
    "authorized_by_user_id" UUID,
    "lease_owner" TEXT,

    CONSTRAINT "message_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_status_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "message_id" UUID,
    "status" "ProviderStatus" NOT NULL,
    "provider_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error_code" TEXT,
    "error_title" TEXT,
    "reconciled_at" TIMESTAMPTZ(6),

    CONSTRAINT "message_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "sender_identity" TEXT NOT NULL,
    "sender_profile_name" TEXT,
    "kind" "InboundKind" NOT NULL,
    "normalized" JSONB NOT NULL,
    "provider_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ingress_sequence" BIGSERIAL NOT NULL,
    "processing_state" "InboundProcessingState" NOT NULL DEFAULT 'PENDING',
    "processed_at" TIMESTAMPTZ(6),
    "outcome_code" TEXT,
    "raw_payload" JSONB,
    "raw_expires_at" TIMESTAMPTZ(6),
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "inbound_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_quarantine" (
    "id" UUID NOT NULL,
    "app_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "phone_number_id" TEXT,
    "raw_payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "webhook_quarantine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "JobKind" NOT NULL,
    "entity_id" UUID,
    "dedupe_key" TEXT NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 50,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(6),
    "last_error_code" TEXT,
    "last_error_at" TIMESTAMPTZ(6),
    "payload" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_snapshots" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "format_version" INTEGER NOT NULL,
    "aggregate" JSONB NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "eligible_count" INTEGER NOT NULL,
    "suppressed_count" INTEGER NOT NULL,
    "questions_shared" INTEGER NOT NULL,
    "questions_suppressed" INTEGER NOT NULL,
    "broadcast_state" "SnapshotBroadcastState" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "result_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_recipients" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "invitation_message_id" UUID,
    "access_state" "ResultAccessState" NOT NULL DEFAULT 'PENDING',
    "suppression_reason" TEXT,
    "viewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "result_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "metadata" JSONB,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_type" "ImportFileType" NOT NULL,
    "file_size" INTEGER NOT NULL,
    "sheet_names" JSONB,
    "sheet_name" TEXT,
    "headers" JSONB,
    "column_mapping" JSONB,
    "default_country" TEXT NOT NULL DEFAULT 'PK',
    "duplicate_mode" "DuplicateMode" NOT NULL DEFAULT 'SKIP_EXISTING',
    "consent_attestation" JSONB,
    "state" "ImportState" NOT NULL DEFAULT 'UPLOADED',
    "summary" JSONB,
    "raw_bytes" BYTEA,
    "raw_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "staging_purged_at" TIMESTAMPTZ(6),
    "previewed_at" TIMESTAMPTZ(6),
    "confirmed_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "status" "ImportRowStatus" NOT NULL,
    "errors" JSONB,
    "normalized" JSONB,
    "contact_id" UUID,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simulator_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "clock_offset_seconds" INTEGER NOT NULL DEFAULT 0,
    "faults" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "simulator_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_firebase_uid_key" ON "users"("firebase_uid");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "organization_memberships_user_id_status_idx" ON "organization_memberships"("user_id", "status");

-- CreateIndex
CREATE INDEX "organization_memberships_organization_id_role_status_idx" ON "organization_memberships"("organization_id", "role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "organization_memberships_organization_id_user_id_key" ON "organization_memberships"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_memberships_organization_id_id_key" ON "organization_memberships"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_invitations_token_hash_key" ON "staff_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "staff_invitations_organization_id_email_idx" ON "staff_invitations"("organization_id", "email");

-- CreateIndex
CREATE INDEX "contacts_organization_id_name_idx" ON "contacts"("organization_id", "name");

-- CreateIndex
CREATE INDEX "contacts_organization_id_archived_at_idx" ON "contacts"("organization_id", "archived_at");

-- CreateIndex
CREATE INDEX "contacts_organization_id_provider_identity_idx" ON "contacts"("organization_id", "provider_identity");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_organization_id_phone_e164_key" ON "contacts"("organization_id", "phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_organization_id_id_key" ON "contacts"("organization_id", "id");

-- CreateIndex
CREATE INDEX "consent_events_organization_id_contact_id_scope_evidence_at_idx" ON "consent_events"("organization_id", "contact_id", "scope", "evidence_at" DESC, "recorded_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "groups_organization_id_normalized_name_key" ON "groups"("organization_id", "normalized_name");

-- CreateIndex
CREATE UNIQUE INDEX "groups_organization_id_id_key" ON "groups"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_organization_id_normalized_name_key" ON "tags"("organization_id", "normalized_name");

-- CreateIndex
CREATE UNIQUE INDEX "tags_organization_id_id_key" ON "tags"("organization_id", "id");

-- CreateIndex
CREATE INDEX "contact_groups_organization_id_group_id_idx" ON "contact_groups"("organization_id", "group_id");

-- CreateIndex
CREATE INDEX "contact_tags_organization_id_tag_id_idx" ON "contact_tags"("organization_id", "tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_organization_id_connection_id_sender_identity_key" ON "enrollments"("organization_id", "connection_id", "sender_identity");

-- CreateIndex
CREATE INDEX "surveys_organization_id_state_archived_at_idx" ON "surveys"("organization_id", "state", "archived_at");

-- CreateIndex
CREATE INDEX "surveys_organization_id_updated_at_idx" ON "surveys"("organization_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "surveys_organization_id_id_key" ON "surveys"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "survey_revisions_organization_id_survey_id_revision_number_key" ON "survey_revisions"("organization_id", "survey_id", "revision_number");

-- CreateIndex
CREATE UNIQUE INDEX "survey_revisions_organization_id_id_key" ON "survey_revisions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "questions_organization_id_revision_id_position_key" ON "questions"("organization_id", "revision_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "questions_organization_id_id_key" ON "questions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "questions_organization_id_revision_id_id_key" ON "questions"("organization_id", "revision_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "question_options_organization_id_question_id_position_key" ON "question_options"("organization_id", "question_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "question_options_organization_id_question_id_code_key" ON "question_options"("organization_id", "question_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "question_options_organization_id_question_id_id_key" ON "question_options"("organization_id", "question_id", "id");

-- CreateIndex
CREATE INDEX "survey_runs_organization_id_state_opens_at_idx" ON "survey_runs"("organization_id", "state", "opens_at");

-- CreateIndex
CREATE INDEX "survey_runs_organization_id_state_closes_at_idx" ON "survey_runs"("organization_id", "state", "closes_at");

-- CreateIndex
CREATE UNIQUE INDEX "survey_runs_organization_id_survey_id_live_slot_key" ON "survey_runs"("organization_id", "survey_id", "live_slot");

-- CreateIndex
CREATE UNIQUE INDEX "survey_runs_organization_id_id_key" ON "survey_runs"("organization_id", "id");

-- CreateIndex
CREATE INDEX "survey_recipients_organization_id_contact_id_idx" ON "survey_recipients"("organization_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "survey_recipients_organization_id_run_id_contact_id_key" ON "survey_recipients"("organization_id", "run_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "survey_recipients_organization_id_id_key" ON "survey_recipients"("organization_id", "id");

-- CreateIndex
CREATE INDEX "invitations_organization_id_run_id_state_idx" ON "invitations"("organization_id", "run_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_organization_id_recipient_id_key" ON "invitations"("organization_id", "recipient_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_organization_id_id_key" ON "invitations"("organization_id", "id");

-- CreateIndex
CREATE INDEX "participations_organization_id_contact_id_idx" ON "participations"("organization_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "participations_organization_id_run_id_contact_id_key" ON "participations"("organization_id", "run_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "participations_organization_id_id_key" ON "participations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "participations_organization_id_id_revision_id_key" ON "participations"("organization_id", "id", "revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_organization_id_contact_id_key" ON "conversations"("organization_id", "contact_id");

-- CreateIndex
CREATE INDEX "answers_organization_id_question_id_idx" ON "answers"("organization_id", "question_id");

-- CreateIndex
CREATE UNIQUE INDEX "answers_organization_id_participation_id_question_id_key" ON "answers"("organization_id", "participation_id", "question_id");

-- CreateIndex
CREATE UNIQUE INDEX "answers_organization_id_id_key" ON "answers"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "answers_organization_id_id_question_id_key" ON "answers"("organization_id", "id", "question_id");

-- CreateIndex
CREATE INDEX "answer_revisions_organization_id_question_id_is_current_idx" ON "answer_revisions"("organization_id", "question_id", "is_current");

-- CreateIndex
CREATE UNIQUE INDEX "answer_revisions_organization_id_answer_id_revision_number_key" ON "answer_revisions"("organization_id", "answer_id", "revision_number");

-- CreateIndex
CREATE UNIQUE INDEX "answer_revisions_organization_id_id_key" ON "answer_revisions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "answer_revisions_organization_id_id_question_id_key" ON "answer_revisions"("organization_id", "id", "question_id");

-- CreateIndex
CREATE INDEX "answer_selections_organization_id_question_id_option_id_idx" ON "answer_selections"("organization_id", "question_id", "option_id");

-- CreateIndex
CREATE UNIQUE INDEX "action_bindings_token_key" ON "action_bindings"("token");

-- CreateIndex
CREATE INDEX "action_bindings_organization_id_contact_id_purpose_idx" ON "action_bindings"("organization_id", "contact_id", "purpose");

-- CreateIndex
CREATE INDEX "action_bindings_expires_at_idx" ON "action_bindings"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "messaging_connections_app_key_key" ON "messaging_connections"("app_key");

-- CreateIndex
CREATE UNIQUE INDEX "messaging_connections_organization_id_id_key" ON "messaging_connections"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "messaging_connections_phone_number_id_key" ON "messaging_connections"("phone_number_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_bindings_organization_id_connection_id_purpose_loc_key" ON "template_bindings"("organization_id", "connection_id", "purpose", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "flow_bindings_organization_id_connection_id_purpose_locale_key" ON "flow_bindings"("organization_id", "connection_id", "purpose", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "messages_dedupe_key_key" ON "messages"("dedupe_key");

-- CreateIndex
CREATE INDEX "messages_organization_id_run_id_kind_idx" ON "messages"("organization_id", "run_id", "kind");

-- CreateIndex
CREATE INDEX "messages_organization_id_contact_id_created_at_idx" ON "messages"("organization_id", "contact_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "messages_organization_id_connection_id_provider_message_id_idx" ON "messages"("organization_id", "connection_id", "provider_message_id");

-- CreateIndex
CREATE INDEX "messages_organization_id_state_idx" ON "messages"("organization_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "messages_organization_id_id_key" ON "messages"("organization_id", "id");

-- CreateIndex
CREATE INDEX "message_attempts_organization_id_provider_message_id_idx" ON "message_attempts"("organization_id", "provider_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_attempts_organization_id_message_id_attempt_number_key" ON "message_attempts"("organization_id", "message_id", "attempt_number");

-- CreateIndex
CREATE INDEX "message_status_events_organization_id_message_id_idx" ON "message_status_events"("organization_id", "message_id");

-- CreateIndex
CREATE INDEX "message_status_events_organization_id_reconciled_at_idx" ON "message_status_events"("organization_id", "reconciled_at");

-- CreateIndex
CREATE UNIQUE INDEX "message_status_events_organization_id_connection_id_provide_key" ON "message_status_events"("organization_id", "connection_id", "provider_message_id", "status", "provider_at");

-- CreateIndex
CREATE INDEX "inbound_events_organization_id_processing_state_received_at_idx" ON "inbound_events"("organization_id", "processing_state", "received_at");

-- CreateIndex
CREATE INDEX "inbound_events_raw_expires_at_idx" ON "inbound_events"("raw_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_events_organization_id_connection_id_provider_messa_key" ON "inbound_events"("organization_id", "connection_id", "provider_message_id");

-- CreateIndex
CREATE INDEX "webhook_quarantine_expires_at_idx" ON "webhook_quarantine"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_dedupe_key_key" ON "jobs"("dedupe_key");

-- CreateIndex
CREATE INDEX "jobs_status_due_at_priority_idx" ON "jobs"("status", "due_at", "priority");

-- CreateIndex
CREATE INDEX "jobs_status_lease_expires_at_idx" ON "jobs"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "jobs_organization_id_kind_entity_id_idx" ON "jobs"("organization_id", "kind", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "result_snapshots_organization_id_run_id_key" ON "result_snapshots"("organization_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "result_snapshots_organization_id_id_key" ON "result_snapshots"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "result_recipients_organization_id_snapshot_id_contact_id_key" ON "result_recipients"("organization_id", "snapshot_id", "contact_id");

-- CreateIndex
CREATE INDEX "audit_events_organization_id_created_at_idx" ON "audit_events"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_organization_id_resource_type_resource_id_idx" ON "audit_events"("organization_id", "resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_events_organization_id_action_idx" ON "audit_events"("organization_id", "action");

-- CreateIndex
CREATE INDEX "import_batches_organization_id_created_at_idx" ON "import_batches"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "import_batches_raw_expires_at_idx" ON "import_batches"("raw_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_organization_id_id_key" ON "import_batches"("organization_id", "id");

-- CreateIndex
CREATE INDEX "import_rows_organization_id_batch_id_status_idx" ON "import_rows"("organization_id", "batch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_organization_id_batch_id_row_number_key" ON "import_rows"("organization_id", "batch_id", "row_number");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_organization_id_scope_key_key" ON "idempotency_keys"("organization_id", "scope", "key");

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_groups" ADD CONSTRAINT "contact_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_groups" ADD CONSTRAINT "contact_groups_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_groups" ADD CONSTRAINT "contact_groups_organization_id_group_id_fkey" FOREIGN KEY ("organization_id", "group_id") REFERENCES "groups"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_organization_id_tag_id_fkey" FOREIGN KEY ("organization_id", "tag_id") REFERENCES "tags"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "messaging_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_revisions" ADD CONSTRAINT "survey_revisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_revisions" ADD CONSTRAINT "survey_revisions_organization_id_survey_id_fkey" FOREIGN KEY ("organization_id", "survey_id") REFERENCES "surveys"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_organization_id_revision_id_fkey" FOREIGN KEY ("organization_id", "revision_id") REFERENCES "survey_revisions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_options" ADD CONSTRAINT "question_options_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_options" ADD CONSTRAINT "question_options_organization_id_question_id_fkey" FOREIGN KEY ("organization_id", "question_id") REFERENCES "questions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_runs" ADD CONSTRAINT "survey_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_runs" ADD CONSTRAINT "survey_runs_organization_id_survey_id_fkey" FOREIGN KEY ("organization_id", "survey_id") REFERENCES "surveys"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_runs" ADD CONSTRAINT "survey_runs_organization_id_revision_id_fkey" FOREIGN KEY ("organization_id", "revision_id") REFERENCES "survey_revisions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_recipients" ADD CONSTRAINT "survey_recipients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_recipients" ADD CONSTRAINT "survey_recipients_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "survey_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_recipients" ADD CONSTRAINT "survey_recipients_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "survey_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_recipient_id_fkey" FOREIGN KEY ("organization_id", "recipient_id") REFERENCES "survey_recipients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_message_id_fkey" FOREIGN KEY ("organization_id", "message_id") REFERENCES "messages"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participations" ADD CONSTRAINT "participations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participations" ADD CONSTRAINT "participations_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "survey_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participations" ADD CONSTRAINT "participations_organization_id_revision_id_fkey" FOREIGN KEY ("organization_id", "revision_id") REFERENCES "survey_revisions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participations" ADD CONSTRAINT "participations_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "messaging_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_foreground_participation_id_fkey" FOREIGN KEY ("organization_id", "foreground_participation_id") REFERENCES "participations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_organization_id_participation_id_revision_id_fkey" FOREIGN KEY ("organization_id", "participation_id", "revision_id") REFERENCES "participations"("organization_id", "id", "revision_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_organization_id_revision_id_fkey" FOREIGN KEY ("organization_id", "revision_id") REFERENCES "survey_revisions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_organization_id_revision_id_question_id_fkey" FOREIGN KEY ("organization_id", "revision_id", "question_id") REFERENCES "questions"("organization_id", "revision_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_revisions" ADD CONSTRAINT "answer_revisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_revisions" ADD CONSTRAINT "answer_revisions_organization_id_answer_id_question_id_fkey" FOREIGN KEY ("organization_id", "answer_id", "question_id") REFERENCES "answers"("organization_id", "id", "question_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_revisions" ADD CONSTRAINT "answer_revisions_organization_id_question_id_fkey" FOREIGN KEY ("organization_id", "question_id") REFERENCES "questions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_selections" ADD CONSTRAINT "answer_selections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_selections" ADD CONSTRAINT "answer_selections_organization_id_answer_revision_id_quest_fkey" FOREIGN KEY ("organization_id", "answer_revision_id", "question_id") REFERENCES "answer_revisions"("organization_id", "id", "question_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_selections" ADD CONSTRAINT "answer_selections_organization_id_question_id_option_id_fkey" FOREIGN KEY ("organization_id", "question_id", "option_id") REFERENCES "question_options"("organization_id", "question_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_bindings" ADD CONSTRAINT "action_bindings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_bindings" ADD CONSTRAINT "action_bindings_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "messaging_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_bindings" ADD CONSTRAINT "action_bindings_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_bindings" ADD CONSTRAINT "action_bindings_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "survey_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_bindings" ADD CONSTRAINT "action_bindings_organization_id_participation_id_fkey" FOREIGN KEY ("organization_id", "participation_id") REFERENCES "participations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_bindings" ADD CONSTRAINT "action_bindings_organization_id_question_id_fkey" FOREIGN KEY ("organization_id", "question_id") REFERENCES "questions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_bindings" ADD CONSTRAINT "action_bindings_organization_id_question_id_option_id_fkey" FOREIGN KEY ("organization_id", "question_id", "option_id") REFERENCES "question_options"("organization_id", "question_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_bindings" ADD CONSTRAINT "action_bindings_organization_id_snapshot_id_fkey" FOREIGN KEY ("organization_id", "snapshot_id") REFERENCES "result_snapshots"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messaging_connections" ADD CONSTRAINT "messaging_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_bindings" ADD CONSTRAINT "template_bindings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_bindings" ADD CONSTRAINT "template_bindings_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "messaging_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_bindings" ADD CONSTRAINT "flow_bindings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_bindings" ADD CONSTRAINT "flow_bindings_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "messaging_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "messaging_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "survey_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_participation_id_fkey" FOREIGN KEY ("organization_id", "participation_id") REFERENCES "participations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_snapshot_id_fkey" FOREIGN KEY ("organization_id", "snapshot_id") REFERENCES "result_snapshots"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_organization_id_message_id_fkey" FOREIGN KEY ("organization_id", "message_id") REFERENCES "messages"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "messaging_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_organization_id_message_id_fkey" FOREIGN KEY ("organization_id", "message_id") REFERENCES "messages"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "messaging_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_snapshots" ADD CONSTRAINT "result_snapshots_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_snapshots" ADD CONSTRAINT "result_snapshots_organization_id_survey_id_fkey" FOREIGN KEY ("organization_id", "survey_id") REFERENCES "surveys"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_snapshots" ADD CONSTRAINT "result_snapshots_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "survey_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_recipients" ADD CONSTRAINT "result_recipients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_recipients" ADD CONSTRAINT "result_recipients_organization_id_snapshot_id_fkey" FOREIGN KEY ("organization_id", "snapshot_id") REFERENCES "result_snapshots"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_recipients" ADD CONSTRAINT "result_recipients_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_recipients" ADD CONSTRAINT "result_recipients_organization_id_invitation_message_id_fkey" FOREIGN KEY ("organization_id", "invitation_message_id") REFERENCES "messages"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_organization_id_batch_id_fkey" FOREIGN KEY ("organization_id", "batch_id") REFERENCES "import_batches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
