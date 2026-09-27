ALTER TABLE "lane" ADD COLUMN "subject" text;--> statement-breakpoint
CREATE INDEX "lane_subject_idx" ON "lane" ("subject") WHERE "state" <> 'idle';