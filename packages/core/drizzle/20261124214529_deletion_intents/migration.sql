ALTER TABLE "project" ADD COLUMN "deleting" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "deleting" boolean DEFAULT false NOT NULL;