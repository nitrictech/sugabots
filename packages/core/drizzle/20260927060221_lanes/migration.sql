CREATE TABLE "lane" (
	"key" text PRIMARY KEY,
	"state" text DEFAULT 'idle' NOT NULL,
	"workflow" text,
	"execution_id" text,
	"payload" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lane_state_check" CHECK ("state" in ('idle', 'starting', 'running')),
	CONSTRAINT "lane_execution_check" CHECK (("state" = 'idle') = ("execution_id" is null))
);
--> statement-breakpoint
CREATE TABLE "lane_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"lane_key" text NOT NULL,
	"workflow" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "lane_busy_idx" ON "lane" ("state","updated_at") WHERE "state" <> 'idle';--> statement-breakpoint
CREATE INDEX "lane_request_order_idx" ON "lane_request" ("lane_key","created_at","id");--> statement-breakpoint
ALTER TABLE "lane_request" ADD CONSTRAINT "lane_request_lane_key_lane_key_fkey" FOREIGN KEY ("lane_key") REFERENCES "lane"("key") ON DELETE CASCADE;