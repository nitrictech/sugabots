ALTER TABLE "pod" DROP COLUMN "routing";--> statement-breakpoint
-- No workflow runs facilitations any more, so a lane left holding one would never be released.
DELETE FROM "lane" WHERE "key" LIKE 'facilitate:%';--> statement-breakpoint
UPDATE "turn" SET "reason" = 'default' WHERE "reason" = 'facilitator';--> statement-breakpoint
-- Turns asked for and not yet finished carry their reason, which no longer reads as 'facilitator'.
UPDATE "lane" SET "payload" = jsonb_set("payload", '{reason}', '"default"') WHERE "workflow" = 'turn' AND "payload"->>'reason' = 'facilitator';--> statement-breakpoint
UPDATE "lane_request" SET "payload" = jsonb_set("payload", '{reason}', '"default"') WHERE "workflow" = 'turn' AND "payload"->>'reason' = 'facilitator';--> statement-breakpoint
DELETE FROM "agent" WHERE "system_agent_key" = 'facilitate';
