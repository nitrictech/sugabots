ALTER TABLE "workspace_invite" ADD COLUMN "sent_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- An invitation's link lasts two days from when it was last sent, so that send is two days before it expires.
UPDATE "workspace_invite" SET "sent_at" = "expires_at" - interval '2 days';
