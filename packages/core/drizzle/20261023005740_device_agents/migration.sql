CREATE TABLE "device" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "a2a_device_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "device_token_digest_idx" ON "device" ("token_digest");--> statement-breakpoint
CREATE INDEX "device_owner_id_idx" ON "device" ("owner_id");--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_a2a_device_id_device_id_fkey" FOREIGN KEY ("a2a_device_id") REFERENCES "device"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_owner_id_user_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_a2a_device_check" CHECK ("a2a_device_id" is null or "a2a_url" is not null);