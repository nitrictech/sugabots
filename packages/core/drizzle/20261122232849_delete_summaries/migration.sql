DROP TABLE "summary";--> statement-breakpoint
DROP TABLE "bot_summary";--> statement-breakpoint
ALTER TABLE "model_request" DROP CONSTRAINT "model_request_purpose_valid", ADD CONSTRAINT "model_request_purpose_valid" CHECK ("purpose" in ('bot-turn', 'facilitation', 'compaction', 'trial', 'provider-check'));