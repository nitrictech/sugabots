-- The architecture's and computers' glossary words: a tool call that may
-- change or delete something is a write/delete tool call, an event is
-- published on a stream, a computer's network mode is open or allowed hosts
-- only, a bot asking to reach a host makes a host request, a reply being
-- written is `writing`, and a model that thinks before it answers has the
-- thinking capability. Everything is renamed in place, keeping every row.
ALTER TABLE "tool_call" RENAME COLUMN "mutating" TO "write_or_delete";--> statement-breakpoint
ALTER TABLE "turn" RENAME COLUMN "mutation_started" TO "write_or_delete_started";--> statement-breakpoint
ALTER TABLE "event" RENAME COLUMN "channel" TO "stream";--> statement-breakpoint
ALTER INDEX "event_channel_seq_idx" RENAME TO "event_stream_seq_idx";--> statement-breakpoint
UPDATE "computer_provider" SET "settings" = jsonb_set("settings", '{networkMode}', '"allowed-hosts-only"') WHERE "settings"->>'networkMode' = 'allowlist';--> statement-breakpoint
UPDATE "tool_call" SET "tool" = 'request_host' WHERE "tool" = 'request_network_access';--> statement-breakpoint
UPDATE "message" SET "status" = 'writing' WHERE "status" = 'streaming';--> statement-breakpoint
UPDATE "provider_model" SET "capabilities" = (
	SELECT coalesce(jsonb_agg(CASE WHEN value = '"reasoning"' THEN '"thinking"'::jsonb ELSE value END), '[]'::jsonb)
	FROM jsonb_array_elements("capabilities")
) WHERE "capabilities" ? 'reasoning';--> statement-breakpoint
UPDATE "provider_model" SET "disabled_capabilities" = (
	SELECT coalesce(jsonb_agg(CASE WHEN value = '"reasoning"' THEN '"thinking"'::jsonb ELSE value END), '[]'::jsonb)
	FROM jsonb_array_elements("disabled_capabilities")
) WHERE "disabled_capabilities" ? 'reasoning';
