CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preference" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notification_user_created_at_idx" ON "notification" ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preference_idx" ON "notification_preference" ("user_id","kind");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_workspace_member_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "workspace_member"("workspace_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;