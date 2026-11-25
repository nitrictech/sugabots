-- Which execution of its turn last sent each tool call, so a newer execution
-- resuming the turn sends a call that changes nothing again only once. Calls
-- sent before have none.
ALTER TABLE "tool_call" ADD COLUMN "sent_in_execution" integer;
