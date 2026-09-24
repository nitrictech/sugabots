DROP INDEX "pod_slug_idx";--> statement-breakpoint
-- Personal pods were given `personal-<uuid>` to stay unique; the check below requires `personal`.
UPDATE "pod" SET "slug" = 'personal' WHERE "kind" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "pod_slug_idx" ON "pod" ("workspace_id","slug") WHERE "kind" = 'shared';--> statement-breakpoint
CREATE INDEX "pod_workspace_id_idx" ON "pod" ("workspace_id");--> statement-breakpoint
ALTER TABLE "pod" ADD CONSTRAINT "pod_personal_slug_check" CHECK (("kind" = 'personal') = ("slug" = 'personal'));