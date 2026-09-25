ALTER TABLE "github_connection" ADD COLUMN "app_id" text;--> statement-breakpoint
ALTER TABLE "github_connection" ADD COLUMN "app_slug" text;--> statement-breakpoint
ALTER TABLE "github_connection" ADD COLUMN "app_private_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "github_connection" ADD COLUMN "app_installation_id" text;--> statement-breakpoint
ALTER TABLE "github_connection" ALTER COLUMN "token_encrypted" DROP NOT NULL;