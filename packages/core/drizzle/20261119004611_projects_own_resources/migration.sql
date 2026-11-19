-- A bot's computer, connections (its GitHub app among them), automations and
-- allowed hosts become its default project's, keeping their ids. Nothing is
-- made again: each computer keeps its provider's id and its folders, so no
-- machine or work is lost; tool calls, waiting approvals and GitHub triggers
-- still name their connections; and OAuth sign-ins carry on as they were.
CREATE TABLE "project_allowed_host" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"host" text,
	"added_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_allowed_host_pkey" PRIMARY KEY("project_id","host")
);
--> statement-breakpoint
ALTER TABLE "computer" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "automation" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "project_allowed_host" ADD CONSTRAINT "project_allowed_host_added_by_id_user_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "project_allowed_host" ADD CONSTRAINT "project_allowed_host_project_workspace_fkey" FOREIGN KEY ("project_id","workspace_id") REFERENCES "project"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
UPDATE "computer" SET "project_id" = "project"."id"
FROM "project" WHERE "project"."default_of_bot_id" = "computer"."bot_id";--> statement-breakpoint
UPDATE "connection" SET "project_id" = "project"."id"
FROM "project" WHERE "project"."default_of_bot_id" = "connection"."bot_id";--> statement-breakpoint
UPDATE "automation" SET "project_id" = "project"."id"
FROM "project" WHERE "project"."default_of_bot_id" = "automation"."bot_id";--> statement-breakpoint
INSERT INTO "project_allowed_host" ("workspace_id", "project_id", "host", "added_by_id", "created_at")
SELECT "host"."workspace_id", "project"."id", "host"."host", "host"."added_by_id", "host"."created_at"
FROM "bot_allowed_host" AS "host"
JOIN "project" ON "project"."default_of_bot_id" = "host"."bot_id";
