ALTER TABLE "session" ADD COLUMN "push_service" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "push_token" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "push_environment" text;--> statement-breakpoint
CREATE UNIQUE INDEX "session_push_token_idx" ON "session" ("push_token") WHERE "push_token" is not null;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_push_device_whole" CHECK (("push_token" is null) = ("push_service" is null));--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_push_service_valid" CHECK ("push_service" in ('apns', 'fcm'));--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_push_environment_for_apns" CHECK (("push_environment" is not null) = ("push_service" is not distinct from 'apns'));--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_push_environment_valid" CHECK ("push_environment" in ('development', 'production'));