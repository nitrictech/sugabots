CREATE TABLE "blob" (
	"key" text PRIMARY KEY,
	"bytes" bytea NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "blob_key_prefix_idx" ON "blob" ("key" text_pattern_ops);