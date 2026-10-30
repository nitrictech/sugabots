CREATE TABLE "notification_override" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"pod_id" uuid,
	"agent_id" uuid,
	"level" text,
	"muted_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_override_level_valid" CHECK ("level" in ('all', 'mentions', 'nothing')),
	CONSTRAINT "notification_override_chooses_something" CHECK (num_nonnulls("level", "muted_until") > 0),
	CONSTRAINT "notification_override_one_place" CHECK (num_nonnulls("pod_id", "agent_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"user_id" uuid PRIMARY KEY,
	"level" text NOT NULL,
	"paused_until" timestamp with time zone,
	"quiet_hours" jsonb,
	"turn_failures" boolean DEFAULT true NOT NULL,
	"routine_runs" text DEFAULT 'failures' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_settings_level_valid" CHECK ("level" in ('all', 'mentions', 'nothing')),
	CONSTRAINT "notification_settings_routine_runs_valid" CHECK ("routine_runs" in ('failures', 'all', 'none'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_override_pod_idx" ON "notification_override" ("user_id","pod_id") WHERE "pod_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_override_agent_idx" ON "notification_override" ("user_id","agent_id") WHERE "agent_id" is not null;--> statement-breakpoint
ALTER TABLE "notification_override" ADD CONSTRAINT "notification_override_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_override" ADD CONSTRAINT "notification_override_pod_id_pod_id_fkey" FOREIGN KEY ("pod_id") REFERENCES "pod"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_override" ADD CONSTRAINT "notification_override_agent_id_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;