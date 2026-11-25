ALTER TABLE "message" ADD COLUMN "joined_turns" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "turn" ADD COLUMN "asker_id" uuid;--> statement-breakpoint
ALTER TABLE "turn" ADD COLUMN "asked_by_automation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "turn" ADD CONSTRAINT "turn_asker_id_member_id_fkey" FOREIGN KEY ("asker_id") REFERENCES "member"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- Who a turn answering `trigger_message` in `chat` acts for, worked out once, when it is asked for and when it is made: the member who wrote the message; when a bot's turn wrote it, that turn's asker, or its run; when its automation's trigger posted it, its run, with no member. A bot's message no turn wrote, such as a brief, or a message not written yet, such as an interview's first reply, acts for the member who started the chat.
CREATE FUNCTION turn_asker(chat uuid, trigger_message uuid, OUT member_id uuid, OUT automation boolean)
LANGUAGE sql STABLE AS $$
	SELECT
		CASE
			WHEN answered.author_member_id IS NOT NULL THEN answered.author_member_id
			WHEN answered.automation_trigger IS NOT NULL THEN NULL
			WHEN writer.id IS NOT NULL THEN writer.asker_id
			ELSE started.started_by_id
		END,
		coalesce(
			answered.automation_trigger IS NOT NULL
				OR (answered.author_member_id IS NULL AND writer.asked_by_automation),
			false
		)
	FROM (SELECT chat AS chat_id) AS asked
	LEFT JOIN "message" AS answered ON answered.id = trigger_message AND answered.chat_id = asked.chat_id
	LEFT JOIN "turn" AS writer ON writer.id = answered.turn_id AND answered.author_bot_id IS NOT NULL
	LEFT JOIN "project_chat" AS started ON started.chat_id = asked.chat_id;
$$;--> statement-breakpoint

-- Stores the asker of every turn as it is made, however it is made.
CREATE FUNCTION set_turn_asker() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	SELECT member_id, automation INTO NEW."asker_id", NEW."asked_by_automation"
	FROM turn_asker(NEW."chat_id", NEW."trigger_message_id");
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER turn_asker
BEFORE INSERT ON "turn"
FOR EACH ROW EXECUTE FUNCTION set_turn_asker();--> statement-breakpoint

-- The turns made before askers were stored keep the asker their chain of turns gave them.
UPDATE "turn" AS t SET ("asker_id", "asked_by_automation") = (
	WITH RECURSIVE asking(turn_id, message_id, visited) AS (
		SELECT t.id, t.trigger_message_id, ARRAY[t.id]
		UNION ALL
		SELECT earlier.id, earlier.trigger_message_id, array_append(asking.visited, earlier.id)
		FROM asking
		INNER JOIN "message" AS asking_message ON asking_message.id = asking.message_id
		INNER JOIN "turn" AS earlier ON earlier.id = asking_message.turn_id
		WHERE asking_message.author_bot_id IS NOT NULL
			AND earlier.id <> ALL(asking.visited)
	)
	SELECT
		CASE
			WHEN end_message.author_member_id IS NOT NULL THEN end_message.author_member_id
			WHEN end_message.automation_trigger IS NULL
				AND (end_message.turn_id IS NULL OR end_message.turn_id = asking.turn_id)
				THEN end_chat.started_by_id
		END,
		coalesce(end_message.author_member_id IS NULL AND end_message.automation_trigger IS NOT NULL, false)
	FROM asking
	INNER JOIN "message" AS end_message ON end_message.id = asking.message_id
	LEFT JOIN "project_chat" AS end_chat ON end_chat.chat_id = end_message.chat_id
	ORDER BY cardinality(asking.visited) DESC
	LIMIT 1
)
WHERE EXISTS (SELECT 1 FROM "message" WHERE "message"."id" = t.trigger_message_id);
