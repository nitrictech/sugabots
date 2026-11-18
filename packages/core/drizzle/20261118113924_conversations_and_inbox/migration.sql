-- The events kept for clients that reconnect name conversations by the old
-- word: the `thread.*` and `conversation.thread_changed` types, `threadId` in
-- their payloads, and `audienceThreadId` on those for the workspace's lists.
-- A client whose last event is gone gets a reset and fetches everything
-- again, so they go.
DELETE FROM "event";
