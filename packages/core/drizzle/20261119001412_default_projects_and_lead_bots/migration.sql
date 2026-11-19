-- Every bot gets a hidden default project, which it leads alone and where its
-- own threads live; every other project gets a lead bot; and a bot's threads
-- become threads of its default project, keeping their ids, so `bot_thread`
-- goes. A bot may now react to a message, with 👀 when it reads one on an
-- optional turn and stays silent.
DROP VIEW "placed_conversation";--> statement-breakpoint
ALTER TABLE "message_reaction" ADD COLUMN "bot_id" uuid;--> statement-breakpoint
ALTER TABLE "project_thread" ADD COLUMN "done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "lead_bot_id" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "default_of_bot_id" uuid;--> statement-breakpoint
ALTER TABLE "message_reaction" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX "project_slug_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "project_slug_idx" ON "project" ("workspace_id","slug") WHERE "default_of_bot_id" is null;--> statement-breakpoint
DROP INDEX "message_reaction_message_user_emoji_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "message_reaction_message_user_emoji_idx" ON "message_reaction" ("message_id","user_id","emoji") WHERE "user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "message_reaction_message_bot_emoji_idx" ON "message_reaction" ("message_id","bot_id","emoji") WHERE "bot_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "project_default_of_bot_idx" ON "project" ("default_of_bot_id");--> statement-breakpoint
CREATE INDEX "project_lead_bot_idx" ON "project" ("lead_bot_id");--> statement-breakpoint
ALTER TABLE "message_reaction" ADD CONSTRAINT "message_reaction_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_lead_bot_id_bot_id_fkey" FOREIGN KEY ("lead_bot_id") REFERENCES "bot"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_default_of_bot_id_bot_id_fkey" FOREIGN KEY ("default_of_bot_id") REFERENCES "bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_reaction" ADD CONSTRAINT "message_reaction_one_reactor" CHECK (num_nonnulls("user_id", "bot_id") = 1);--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_default_led_by_its_bot" CHECK ("default_of_bot_id" is null or "lead_bot_id" = "default_of_bot_id");--> statement-breakpoint
-- Each project is led by the first public bot added to it that is still there.
-- One with no bots stays without a lead until somebody chooses one.
UPDATE "project" AS p SET "lead_bot_id" = (
	SELECT pb."bot_id"
	FROM "project_bot" pb
	INNER JOIN "bot" b ON b."id" = pb."bot_id"
	WHERE pb."project_id" = p."id"
		AND b."visibility" = 'public'
		AND b."system_bot_key" IS NULL
		AND b."assistant_of" IS NULL
	ORDER BY pb."created_at", pb."bot_id"
	LIMIT 1
);--> statement-breakpoint
-- Nobody is a member of a default project, administrators included: whoever
-- reaches its bot reaches it.
CREATE OR REPLACE FUNCTION add_administrators_to_new_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."default_of_bot_id" IS NOT NULL THEN
		RETURN NULL;
	END IF;
	PERFORM lock_project_membership(NEW."workspace_id");
	INSERT INTO "project_member" ("workspace_id", "project_id", "user_id")
	SELECT NEW."workspace_id", NEW."id", "user_id"
	FROM "workspace_member"
	WHERE "workspace_id" = NEW."workspace_id" AND "role" IN ('owner', 'admin')
	ON CONFLICT ("project_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION add_new_administrator_to_projects() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_project_membership(NEW."workspace_id");
	INSERT INTO "project_member" ("workspace_id", "project_id", "user_id")
	SELECT NEW."workspace_id", "id", NEW."user_id"
	FROM "project"
	WHERE "workspace_id" = NEW."workspace_id" AND "default_of_bot_id" IS NULL
	ON CONFLICT ("project_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
-- Every bot but a system bot has a default project from the moment it is
-- made, with itself as its lead and only bot. Its name, slug and visibility
-- are placeholders: it is never listed or addressed by them.
CREATE FUNCTION add_default_project_to_new_bot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	made uuid;
BEGIN
	INSERT INTO "project" ("workspace_id", "name", "slug", "visibility", "created_by_id", "lead_bot_id", "default_of_bot_id")
	VALUES (NEW."workspace_id", NEW."name", 'bot-' || NEW."id"::text, 'private', NEW."created_by_id", NEW."id", NEW."id")
	RETURNING "id" INTO made;
	INSERT INTO "project_bot" ("workspace_id", "project_id", "bot_id")
	VALUES (NEW."workspace_id", made, NEW."id");
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER bot_default_project
AFTER INSERT ON "bot"
FOR EACH ROW WHEN (NEW."system_bot_key" IS NULL)
EXECUTE FUNCTION add_default_project_to_new_bot();--> statement-breakpoint
INSERT INTO "project" ("workspace_id", "name", "slug", "visibility", "created_by_id", "lead_bot_id", "default_of_bot_id", "created_at")
SELECT "workspace_id", "name", 'bot-' || "id"::text, 'private', "created_by_id", "id", "id", "created_at"
FROM "bot"
WHERE "system_bot_key" IS NULL;--> statement-breakpoint
INSERT INTO "project_bot" ("workspace_id", "project_id", "bot_id", "created_at")
SELECT p."workspace_id", p."id", p."default_of_bot_id", p."created_at"
FROM "project" p
WHERE p."default_of_bot_id" IS NOT NULL;--> statement-breakpoint
-- A bot's threads become its default project's, keeping their ids, so every
-- message, turn, file and link to them stays as it was. `bot_thread` names its
-- conversation by `(id, kind)`, and deleting its row would delete the
-- conversation, so both go before the conversations change kind.
DROP TRIGGER "bot_thread_conversation_deletion" ON "bot_thread";--> statement-breakpoint
ALTER TABLE "bot_thread" DROP CONSTRAINT "bot_thread_conversation_fkey";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "conversation_kind_valid";--> statement-breakpoint
UPDATE "conversation" SET "kind" = 'project_thread' WHERE "kind" = 'bot_thread';--> statement-breakpoint
INSERT INTO "project_thread" ("conversation_id", "workspace_id", "project_id", "started_by_id", "done_at")
SELECT t."conversation_id", t."workspace_id", p."id", t."started_by_id", t."done_at"
FROM "bot_thread" t
INNER JOIN "project" p ON p."default_of_bot_id" = t."bot_id";--> statement-breakpoint
DROP TABLE "bot_thread";--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_kind_valid" CHECK ("kind" in ('project_thread', 'direct_message', 'collaboration', 'run', 'automation_feed', 'system'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION conversation_has_kind_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	has_kind_row boolean;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM "conversation" WHERE "id" = NEW."id") THEN
		RETURN NULL;
	END IF;
	has_kind_row := CASE NEW."kind"
		WHEN 'project_thread' THEN EXISTS (SELECT 1 FROM "project_thread" WHERE "conversation_id" = NEW."id")
		WHEN 'direct_message' THEN EXISTS (SELECT 1 FROM "direct_message" WHERE "conversation_id" = NEW."id")
		WHEN 'collaboration' THEN EXISTS (SELECT 1 FROM "collaboration" WHERE "conversation_id" = NEW."id")
		WHEN 'run' THEN EXISTS (SELECT 1 FROM "run" WHERE "conversation_id" = NEW."id")
		WHEN 'automation_feed' THEN EXISTS (SELECT 1 FROM "automation_feed" WHERE "conversation_id" = NEW."id")
		WHEN 'system' THEN EXISTS (SELECT 1 FROM "system_conversation" WHERE "conversation_id" = NEW."id")
		ELSE false
	END;
	IF NOT has_kind_row THEN
		RAISE EXCEPTION 'conversation % is a % with no % row', NEW."id", NEW."kind", NEW."kind"
			USING ERRCODE = 'foreign_key_violation';
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE VIEW "placed_conversation" AS (select
	c.id, c.workspace_id, c.kind, c.title, c.created_at, c.updated_at,
	coalesce(p.default_of_bot_id, co.collaborator_bot_id, r.bot_id, fa.bot_id, sc.bot_id) as bot_id,
	cc.project_id,
	case c.kind
		when 'collaboration' then co.root_conversation_id
		when 'run' then rf.conversation_id
		when 'system' then null
		else c.id
	end as root_conversation_id,
	coalesce(co.parent_conversation_id, sc.served_conversation_id) as parent_conversation_id,
	coalesce(cc.started_by_id, dm.started_by_id) as started_by_id,
	sc.system_bot_key,
	cc.done_at,
	f.automation_id,
	cc.archived_at,
	dm.direct_key
from "conversation" c
left join "project_thread" cc on cc.conversation_id = c.id
left join "project" p on p.id = cc.project_id
left join "direct_message" dm on dm.conversation_id = c.id
left join "collaboration" co on co.conversation_id = c.id
left join "run" r on r.conversation_id = c.id
left join "automation_feed" rf on rf.automation_id = r.automation_id
left join "automation_feed" f on f.conversation_id = c.id
left join "automation" fa on fa.id = f.automation_id
left join "system_conversation" sc on sc.conversation_id = c.id);