ALTER TABLE "membership" ADD COLUMN "leaving" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_owner_stays" CHECK (not "leaving" or "role" <> 'owner');--> statement-breakpoint
UPDATE "membership"
SET "leaving" = true
FROM "bot"
JOIN "project" ON "project"."workspace_id" = "bot"."workspace_id"
	AND "project"."default_of_bot_id" = "bot"."id"
WHERE "membership"."workspace_id" = "bot"."workspace_id"
	AND "membership"."member_id" = "bot"."assistant_of"
	AND "membership"."role" <> 'owner'
	AND "project"."deleting";--> statement-breakpoint
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
	WHERE "workspace_id" = NEW."workspace_id" AND NOT "leaving" AND "role" IN ('owner', 'admin')
	ON CONFLICT ("project_id", "member_id") DO NOTHING;
	RETURN NULL;
END;
$$;
