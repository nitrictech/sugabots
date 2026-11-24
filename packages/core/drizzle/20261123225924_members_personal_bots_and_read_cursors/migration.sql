-- Members, personal bots and read cursors by their glossary names: a person
-- is a member, a bot only its creator sees is a personal bot, and how far a
-- member has read a chat is their read cursor. Everything is renamed in place,
-- keeping every row.
ALTER TABLE "chat_read" RENAME TO "read_cursor";--> statement-breakpoint
ALTER TABLE "person" RENAME TO "member";--> statement-breakpoint
ALTER TABLE "chat_participant" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "message" RENAME COLUMN "author_person_id" TO "author_member_id";--> statement-breakpoint
ALTER TABLE "message_reaction" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "read_cursor" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "notification_override" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "notification_settings" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "account" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "membership" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "pinned_bot" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "project_member" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER INDEX "chat_participant_person_idx" RENAME TO "chat_participant_member_idx";--> statement-breakpoint
ALTER INDEX "message_reaction_message_person_emoji_idx" RENAME TO "message_reaction_message_member_emoji_idx";--> statement-breakpoint
ALTER INDEX "chat_read_person_chat_idx" RENAME TO "read_cursor_member_chat_idx";--> statement-breakpoint
ALTER INDEX "account_person_id_idx" RENAME TO "account_member_id_idx";--> statement-breakpoint
ALTER INDEX "person_email_idx" RENAME TO "member_email_idx";--> statement-breakpoint
ALTER INDEX "person_referral_code_idx" RENAME TO "member_referral_code_idx";--> statement-breakpoint
ALTER INDEX "person_referred_by_idx" RENAME TO "member_referred_by_idx";--> statement-breakpoint
ALTER INDEX "membership_person_id_idx" RENAME TO "membership_member_id_idx";--> statement-breakpoint
ALTER INDEX "project_member_person_id_idx" RENAME TO "project_member_member_id_idx";--> statement-breakpoint
ALTER INDEX "session_person_id_idx" RENAME TO "session_member_id_idx";--> statement-breakpoint
-- What Postgres and Drizzle named for the renamed tables and columns: primary
-- keys, foreign keys and not-null constraints.
DO $$
DECLARE
	found record;
BEGIN
	FOR found IN
		SELECT c.conrelid::regclass AS relation, c.conname
		FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
		WHERE n.nspname = 'public' AND c.conname ~ '(person(?!al)|chat_read)'
	LOOP
		EXECUTE format(
			'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
			found.relation,
			found.conname,
			regexp_replace(replace(found.conname, 'chat_read', 'read_cursor'), 'person(?!al)', 'member', 'g')
		);
	END LOOP;
END;
$$;--> statement-breakpoint
DROP INDEX "chat_participant_member_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "chat_participant_member_idx" ON "chat_participant" ("chat_id","member_id") WHERE "member_id" is not null;--> statement-breakpoint
DROP INDEX "message_reaction_message_member_emoji_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "message_reaction_message_member_emoji_idx" ON "message_reaction" ("message_id","member_id","emoji") WHERE "member_id" is not null;--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_one_author", ADD CONSTRAINT "message_one_author" CHECK (num_nonnulls("author_member_id", "author_bot_id", "automation_trigger") = 1);--> statement-breakpoint
ALTER TABLE "chat_participant" DROP CONSTRAINT "chat_participant_one_identity", ADD CONSTRAINT "chat_participant_one_identity" CHECK (num_nonnulls("member_id", "bot_id") = 1);--> statement-breakpoint
ALTER TABLE "message_reaction" DROP CONSTRAINT "message_reaction_one_reactor", ADD CONSTRAINT "message_reaction_one_reactor" CHECK (num_nonnulls("member_id", "bot_id") = 1);--> statement-breakpoint
-- A bot only its creator sees is a personal bot; a private bot is now one its
-- creator invites others to, which Sugabots doesn't have yet.
ALTER TABLE "bot" DROP CONSTRAINT "bot_visibility_check";--> statement-breakpoint
UPDATE "bot" SET "visibility" = 'personal' WHERE "visibility" = 'private';--> statement-breakpoint
ALTER TABLE "bot" ADD CONSTRAINT "bot_visibility_check" CHECK ("visibility" in ('public', 'personal'));--> statement-breakpoint
-- The triggers that put administrators in every project members made name the
-- renamed column.
CREATE OR REPLACE FUNCTION add_administrators_to_new_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."default_of_bot_id" IS NOT NULL THEN
		RETURN NULL;
	END IF;
	PERFORM lock_project_membership(NEW."workspace_id");
	INSERT INTO "project_member" ("workspace_id", "project_id", "member_id")
	SELECT NEW."workspace_id", NEW."id", "member_id"
	FROM "membership"
	WHERE "workspace_id" = NEW."workspace_id" AND "role" IN ('owner', 'admin')
	ON CONFLICT ("project_id", "member_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION add_new_administrator_to_projects() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_project_membership(NEW."workspace_id");
	INSERT INTO "project_member" ("workspace_id", "project_id", "member_id")
	SELECT NEW."workspace_id", "id", NEW."member_id"
	FROM "project"
	WHERE "workspace_id" = NEW."workspace_id" AND "default_of_bot_id" IS NULL
	ON CONFLICT ("project_id", "member_id") DO NOTHING;
	RETURN NULL;
END;
$$;
