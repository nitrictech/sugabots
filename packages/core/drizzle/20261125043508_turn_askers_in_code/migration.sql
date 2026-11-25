-- The turn store now writes each turn's asker as it makes the turn, so no trigger does.
DROP TRIGGER "turn_asker" ON "turn";--> statement-breakpoint
DROP FUNCTION set_turn_asker();--> statement-breakpoint
DROP FUNCTION turn_asker(uuid, uuid);--> statement-breakpoint

-- Who the bot `answering_bot`'s turn answering `trigger_message` in `chat` acts for: the member who wrote the message; when a bot's turn wrote it, that turn's asker, or its run; when its automation's trigger posted it, its run. A Personal Assistant's run, in its own chats, acts for its member. A bot's message no turn wrote, such as a brief, acts for the member who started the chat, and so does an interview's turn, which answers its own first reply.
CREATE FUNCTION turn_asker(chat uuid, trigger_message uuid, answering_bot uuid, OUT member_id uuid, OUT automation boolean)
LANGUAGE sql STABLE AS $$
	SELECT
		coalesce(asked.member_id, CASE WHEN asked.automation AND run.id IS NOT NULL THEN assistant.assistant_of END),
		asked.automation
	FROM (
		SELECT
			CASE
				WHEN answered.author_member_id IS NOT NULL THEN answered.author_member_id
				WHEN answered.automation_trigger IS NOT NULL THEN NULL
				WHEN writer.id IS NOT NULL THEN writer.asker_id
				ELSE started.started_by_id
			END AS member_id,
			coalesce(
				answered.automation_trigger IS NOT NULL
					OR (answered.author_member_id IS NULL AND writer.asked_by_automation),
				false
			) AS automation
		FROM (SELECT chat AS chat_id) AS asking
		LEFT JOIN "message" AS answered ON answered.id = trigger_message AND answered.chat_id = asking.chat_id
		LEFT JOIN "turn" AS writer ON writer.id = answered.turn_id AND answered.author_bot_id IS NOT NULL
		LEFT JOIN "project_chat" AS started ON started.chat_id = asking.chat_id
	) AS asked
	LEFT JOIN "run" AS run ON run.chat_id = chat
	LEFT JOIN "placed_chat" AS place ON place.id = chat
	LEFT JOIN "project" AS own ON own.id = place.project_id AND own.default_of_bot_id = answering_bot
	LEFT JOIN "bot" AS assistant ON assistant.id = own.default_of_bot_id;
$$;--> statement-breakpoint

-- A Personal Assistant's runs' turns, in its own chats, act for its member, which they now store.
UPDATE "turn" AS t SET "asker_id" = assistant."assistant_of"
FROM "run" AS run, "placed_chat" AS place, "project" AS own, "bot" AS assistant
WHERE t."asker_id" IS NULL
	AND t."asked_by_automation"
	AND run."chat_id" = t."chat_id"
	AND place."id" = t."chat_id"
	AND own."id" = place."project_id"
	AND own."default_of_bot_id" = t."bot_id"
	AND assistant."id" = t."bot_id"
	AND assistant."assistant_of" IS NOT NULL;--> statement-breakpoint

-- A turn still in flight that the backfill found nobody to act for is asked to end, so it ends as it next runs, or, waiting, as the cancel sweep tells its workflow.
UPDATE "turn" AS t SET "end_requested" = 'lost_reach'
FROM "chat" AS c
WHERE c."id" = t."chat_id"
	AND c."kind" <> 'system_chat'
	AND t."asker_id" IS NULL
	AND NOT t."asked_by_automation"
	AND t."end_requested" IS NULL
	AND (t."status" IN ('running', 'waiting') OR (t."status" = 'failed' AND t."retrying"));
