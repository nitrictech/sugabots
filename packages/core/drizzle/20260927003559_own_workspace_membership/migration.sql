-- Hand-written, as Drizzle cannot generate data changes: brings rows better-auth
-- wrote within the constraints below. A role outside the supported three
-- already granted nothing, so those rows go.
UPDATE "workspace_invite" SET "role" = 'member' WHERE "role" IS NULL;--> statement-breakpoint
DELETE FROM "workspace_invite" WHERE "role" NOT IN ('admin', 'member', 'viewer');--> statement-breakpoint
DELETE FROM "workspace_member" WHERE "role" NOT IN ('admin', 'member', 'viewer');--> statement-breakpoint
UPDATE "workspace_invite" SET "status" = 'canceled' WHERE "status" NOT IN ('pending', 'accepted', 'canceled');--> statement-breakpoint
UPDATE "workspace_invite" SET "email" = lower("email") WHERE "email" <> lower("email");--> statement-breakpoint
ALTER TABLE "session" DROP CONSTRAINT "session_active_workspace_id_workspace_id_fkey";--> statement-breakpoint
ALTER TABLE "session" DROP COLUMN "active_workspace_id";--> statement-breakpoint
ALTER TABLE "workspace" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "workspace_invite" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "workspace_invite" ALTER COLUMN "role" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_invite" ADD CONSTRAINT "workspace_invite_role_check" CHECK ("role" in ('admin', 'member', 'viewer'));--> statement-breakpoint
ALTER TABLE "workspace_invite" ADD CONSTRAINT "workspace_invite_status_check" CHECK ("status" in ('pending', 'accepted', 'canceled'));--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_role_check" CHECK ("role" in ('admin', 'member', 'viewer'));
