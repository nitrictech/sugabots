ALTER TABLE "model_request" DROP CONSTRAINT "model_request_purpose_valid";--> statement-breakpoint
UPDATE "model_request" SET "purpose" = 'provider-check' WHERE "purpose" = 'probe';--> statement-breakpoint
ALTER TABLE "model_request" ADD CONSTRAINT "model_request_purpose_valid" CHECK ("purpose" in ('agent-turn', 'facilitation', 'summary', 'compaction', 'trial', 'provider-check'));
