ALTER TABLE "sandbox" ADD COLUMN "disk_usage" jsonb;--> statement-breakpoint
ALTER TABLE "sandbox" ADD COLUMN "disk_measured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_disk_measured_check" CHECK (("disk_usage" is null) = ("disk_measured_at" is null));