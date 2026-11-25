ALTER TABLE "computer_lease" ADD COLUMN "provider_computer_id" text;--> statement-breakpoint
UPDATE "computer_lease"
SET "provider_computer_id" = "computer"."provider_computer_id"
FROM "computer"
WHERE "computer_lease"."computer_id" = "computer"."id";--> statement-breakpoint
ALTER TABLE "computer_lease" ALTER COLUMN "provider_computer_id" SET NOT NULL;
