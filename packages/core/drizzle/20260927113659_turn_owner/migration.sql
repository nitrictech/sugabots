ALTER TABLE "turn" DROP CONSTRAINT "turn_job_id_job_id_fkey";--> statement-breakpoint
ALTER TABLE "turn" RENAME COLUMN "job_id" TO "owner";--> statement-breakpoint
ALTER TABLE "turn" ADD COLUMN "runs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "turn" ALTER COLUMN "owner" SET DATA TYPE text USING "owner"::text;