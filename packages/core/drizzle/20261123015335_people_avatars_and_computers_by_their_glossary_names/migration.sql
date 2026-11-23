-- People, memberships, invitations, avatars and computers by their glossary
-- names: a user is a person, a workspace member's place is a membership, an
-- invite is an invitation, a bot's face is its eyes, a computer sleeps, and a
-- workspace is set up. Everything is renamed in place, keeping every row.
ALTER TABLE "workspace_invite" RENAME TO "invitation";--> statement-breakpoint
ALTER TABLE "workspace_member" RENAME TO "membership";--> statement-breakpoint
ALTER TABLE "user" RENAME TO "person";--> statement-breakpoint
ALTER TABLE "chat_participant" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "chat_read" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "message" RENAME COLUMN "author_user_id" TO "author_person_id";--> statement-breakpoint
ALTER TABLE "message_reaction" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "computer" RENAME COLUMN "paused_at" TO "slept_at";--> statement-breakpoint
ALTER TABLE "notification_override" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "notification_settings" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "account" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "bot" RENAME COLUMN "face" TO "eyes";--> statement-breakpoint
ALTER TABLE "membership" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "pinned_bot" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "project_member" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "workspace" RENAME COLUMN "setup_completed_at" TO "set_up_at";--> statement-breakpoint
ALTER TABLE "invitation" RENAME CONSTRAINT "workspace_invite_role_check" TO "invitation_role_check";--> statement-breakpoint
ALTER TABLE "invitation" RENAME CONSTRAINT "workspace_invite_status_check" TO "invitation_status_check";--> statement-breakpoint
ALTER TABLE "membership" RENAME CONSTRAINT "workspace_member_role_check" TO "membership_role_check";--> statement-breakpoint
ALTER INDEX "chat_participant_user_idx" RENAME TO "chat_participant_person_idx";--> statement-breakpoint
ALTER INDEX "chat_read_user_chat_idx" RENAME TO "chat_read_person_chat_idx";--> statement-breakpoint
ALTER INDEX "message_reaction_message_user_emoji_idx" RENAME TO "message_reaction_message_person_emoji_idx";--> statement-breakpoint
ALTER INDEX "account_user_id_idx" RENAME TO "account_person_id_idx";--> statement-breakpoint
ALTER INDEX "workspace_invite_workspace_id_idx" RENAME TO "invitation_workspace_id_idx";--> statement-breakpoint
ALTER INDEX "workspace_invite_email_idx" RENAME TO "invitation_email_idx";--> statement-breakpoint
ALTER INDEX "workspace_member_idx" RENAME TO "membership_idx";--> statement-breakpoint
ALTER INDEX "workspace_member_user_id_idx" RENAME TO "membership_person_id_idx";--> statement-breakpoint
ALTER INDEX "workspace_member_owner_idx" RENAME TO "membership_owner_idx";--> statement-breakpoint
ALTER INDEX "user_email_idx" RENAME TO "person_email_idx";--> statement-breakpoint
ALTER INDEX "user_referral_code_idx" RENAME TO "person_referral_code_idx";--> statement-breakpoint
ALTER INDEX "user_referred_by_idx" RENAME TO "person_referred_by_idx";--> statement-breakpoint
ALTER INDEX "project_member_user_id_idx" RENAME TO "project_member_person_id_idx";--> statement-breakpoint
ALTER INDEX "session_user_id_idx" RENAME TO "session_person_id_idx";--> statement-breakpoint
ALTER TABLE "invitation" ALTER COLUMN "role" SET DEFAULT 'editor';--> statement-breakpoint
ALTER TABLE "membership" ALTER COLUMN "role" SET DEFAULT 'editor';--> statement-breakpoint
-- What Postgres and Drizzle named for the renamed tables and columns: primary
-- keys, foreign keys and not-null constraints.
DO $$
DECLARE
	found record;
	renamed text;
BEGIN
	FOR found IN
		SELECT c.conrelid::regclass AS relation, c.conname
		FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
		WHERE n.nspname = 'public'
			AND c.conname ~ '(workspace_invite|workspace_member|user_id|^user_|^bot_face_)'
	LOOP
		renamed := replace(replace(found.conname, 'workspace_invite', 'invitation'), 'workspace_member', 'membership');
		renamed := regexp_replace(renamed, '^user_', 'person_');
		renamed := replace(renamed, 'user_id', 'person_id');
		renamed := regexp_replace(renamed, '^bot_face_', 'bot_eyes_');
		EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', found.relation, found.conname, renamed);
	END LOOP;
END;
$$;--> statement-breakpoint
-- The editor role was called member.
ALTER TABLE "invitation" DROP CONSTRAINT "invitation_role_check";--> statement-breakpoint
ALTER TABLE "membership" DROP CONSTRAINT "membership_role_check";--> statement-breakpoint
UPDATE "invitation" SET "role" = 'editor' WHERE "role" = 'member';--> statement-breakpoint
UPDATE "membership" SET "role" = 'editor' WHERE "role" = 'member';--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_role_check" CHECK ("role" in ('admin', 'editor', 'viewer'));--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_role_check" CHECK ("role" in ('owner', 'admin', 'editor', 'viewer'));--> statement-breakpoint
-- The triggers that put administrators in every project people made name the
-- renamed table and column.
CREATE OR REPLACE FUNCTION add_administrators_to_new_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."default_of_bot_id" IS NOT NULL THEN
		RETURN NULL;
	END IF;
	PERFORM lock_project_membership(NEW."workspace_id");
	INSERT INTO "project_member" ("workspace_id", "project_id", "person_id")
	SELECT NEW."workspace_id", NEW."id", "person_id"
	FROM "membership"
	WHERE "workspace_id" = NEW."workspace_id" AND "role" IN ('owner', 'admin')
	ON CONFLICT ("project_id", "person_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION add_new_administrator_to_projects() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_project_membership(NEW."workspace_id");
	INSERT INTO "project_member" ("workspace_id", "project_id", "person_id")
	SELECT NEW."workspace_id", "id", NEW."person_id"
	FROM "project"
	WHERE "workspace_id" = NEW."workspace_id" AND "default_of_bot_id" IS NULL
	ON CONFLICT ("project_id", "person_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
-- Request purposes are the glossary's: facilitation is gone, and a trial or
-- provider check is a model test.
ALTER TABLE "model_request" DROP CONSTRAINT "model_request_purpose_valid";--> statement-breakpoint
UPDATE "model_request" SET "purpose" = 'model-test' WHERE "purpose" IN ('trial', 'provider-check');--> statement-breakpoint
DELETE FROM "model_request" WHERE "purpose" = 'facilitation';--> statement-breakpoint
ALTER TABLE "model_request" ADD CONSTRAINT "model_request_purpose_valid" CHECK ("purpose" in ('bot-turn', 'compaction', 'model-test'));--> statement-breakpoint
-- Written files' blobs are kept under `files/<id>`.
CREATE OR REPLACE FUNCTION queue_deleted_file_blobs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "blob_deletion" ("prefix")
	SELECT 'files/' || "id"::text FROM deleted_files WHERE "kind" IN ('document', 'html');
	RETURN NULL;
END;
$$;--> statement-breakpoint
UPDATE "blob" SET "key" = 'files/' || substring("key" from 11) WHERE "key" LIKE 'artifacts/%';--> statement-breakpoint
UPDATE "blob_deletion" SET "prefix" = 'files/' || substring("prefix" from 11) WHERE "prefix" LIKE 'artifacts/%';--> statement-breakpoint
-- Workflow payloads and lanes by their glossary names: a turn's and a
-- compaction's bot is `botId`, an automation's run is `automationId` and
-- `runId`, its workflow and lane are `automation`, and a turn an automation
-- asked for has the reason `automation`.
UPDATE "turn" SET "reason" = 'automation' WHERE "reason" = 'routine';
