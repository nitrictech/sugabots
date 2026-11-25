-- A tool call is recorded as sent before it is sent, under its turn, the
-- step that made it and the model's id for it, so only one execution of the
-- turn sends it. Calls made before steps were recorded have no step, and
-- keep no such key.
DROP INDEX "tool_call_sdk_call_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_step_call_idx" ON "tool_call" ("turn_id","step","sdk_tool_call_id");
