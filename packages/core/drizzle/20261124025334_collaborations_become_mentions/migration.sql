-- A bot asks another of its project's bots for help by mentioning it, and the
-- helper replies in the asking chat, so collaboration chats go. Each one's
-- messages move into the chat it was opened from, among that chat's own in
-- time order; one opened from another collaboration moves to the nearest chat
-- above it that isn't one. Its turns, tool calls, participants and files move
-- with them. The work still going on in those chats ends first, and the
-- collaboration cards in the asking replies go, as the messages they stood
-- for are in the chat now.
CREATE TABLE "collaboration_move" AS
WITH RECURSIVE above AS (
	SELECT "chat_id", "parent_chat_id" AS "target_chat_id" FROM "collaboration"
	UNION ALL
	SELECT above."chat_id", up."parent_chat_id"
	FROM above JOIN "collaboration" up ON up."chat_id" = above."target_chat_id"
)
SELECT "chat_id", "target_chat_id" FROM above
WHERE "target_chat_id" NOT IN (SELECT "chat_id" FROM "collaboration");--> statement-breakpoint
-- The work still going on there ends, as cancelling a turn ends it: its
-- unfinished tool calls fail, a pending approval is denied, and its reply stops.
UPDATE "tool_call" SET
	"status" = 'failed',
	"approval_status" = CASE WHEN "approval_status" = 'pending' THEN 'denied' ELSE "approval_status" END,
	"error" = 'Turn cancelled',
	"finished_at" = now()
WHERE "chat_id" IN (SELECT "chat_id" FROM "collaboration_move")
	AND "status" IN ('running', 'awaiting_approval');--> statement-breakpoint
UPDATE "message" SET "status" = 'cancelled'
WHERE "chat_id" IN (SELECT "chat_id" FROM "collaboration_move") AND "status" = 'writing';--> statement-breakpoint
UPDATE "turn" SET
	"status" = 'cancelled',
	"interrupt_requested" = true,
	"checkpoint" = NULL,
	"finished_at" = now()
WHERE "chat_id" IN (SELECT "chat_id" FROM "collaboration_move")
	AND "status" IN ('running', 'waiting');--> statement-breakpoint
-- Turns and compactions asked for there never start.
DELETE FROM "lane" WHERE "subject" IN (SELECT "chat_id"::text FROM "collaboration_move");--> statement-breakpoint
UPDATE "message" SET "chat_id" = moved."target_chat_id"
FROM "collaboration_move" moved WHERE "message"."chat_id" = moved."chat_id";--> statement-breakpoint
UPDATE "turn" SET "chat_id" = moved."target_chat_id"
FROM "collaboration_move" moved WHERE "turn"."chat_id" = moved."chat_id";--> statement-breakpoint
UPDATE "tool_call" SET "chat_id" = moved."target_chat_id"
FROM "collaboration_move" moved WHERE "tool_call"."chat_id" = moved."chat_id";--> statement-breakpoint
UPDATE "file" SET "chat_id" = moved."target_chat_id"
FROM "collaboration_move" moved WHERE "file"."chat_id" = moved."chat_id";--> statement-breakpoint
-- A file's bytes are kept under its chat's folder, so they follow it there.
-- This moves those the Postgres blob store keeps; deleting the collaboration
-- chats below queues whatever is left under their folders for deletion.
UPDATE "blob" SET "key" = 'chats/' || moved."target_chat_id" || substr("blob"."key", length('chats/' || moved."chat_id") + 1)
FROM "collaboration_move" moved
WHERE "blob"."key" LIKE 'chats/' || moved."chat_id" || '/%';--> statement-breakpoint
-- The ledger keeps which chat a model request served.
UPDATE "model_request" SET "chat_id" = moved."target_chat_id"
FROM "collaboration_move" moved WHERE "model_request"."chat_id" = moved."chat_id";--> statement-breakpoint
INSERT INTO "chat_participant" ("chat_id", "member_id", "bot_id", "created_at")
SELECT moved."target_chat_id", participant."member_id", participant."bot_id", participant."created_at"
FROM "chat_participant" participant
JOIN "collaboration_move" moved ON moved."chat_id" = participant."chat_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- What was recorded on the collaboration chats' own streams, and the cards'
-- updates, which no client shows any more.
DELETE FROM "event"
WHERE "type" = 'collaboration.updated'
	OR "stream" IN (SELECT 'chat:' || "chat_id" FROM "collaboration_move");--> statement-breakpoint
-- The asking replies without their collaboration cards, the text on either
-- side of a card joined again.
WITH kept AS (
	SELECT "message"."id" AS "message_id", element.part, element.position
	FROM "message", jsonb_array_elements("message"."parts") WITH ORDINALITY AS element(part, position)
	WHERE "message"."parts" @> '[{"type": "collaboration"}]'
		AND element.part->>'type' <> 'collaboration'
), starts AS (
	SELECT kept.*,
		CASE WHEN kept.part->>'type' = 'text' AND lag(kept.part->>'type') OVER in_order = 'text' THEN 0 ELSE 1 END AS starts_run
	FROM kept
	WINDOW in_order AS (PARTITION BY kept."message_id" ORDER BY kept.position)
), runs AS (
	SELECT starts.*,
		sum(starts.starts_run) OVER (PARTITION BY starts."message_id" ORDER BY starts.position) AS run
	FROM starts
), joined AS (
	SELECT runs."message_id", runs.run,
		CASE WHEN count(*) > 1
			THEN jsonb_build_object('type', 'text', 'text', string_agg(runs.part->>'text', '' ORDER BY runs.position))
			ELSE (array_agg(runs.part))[1]
		END AS part
	FROM runs
	GROUP BY runs."message_id", runs.run
)
UPDATE "message" SET "parts" = coalesce(
	(SELECT jsonb_agg(joined.part ORDER BY joined.run) FROM joined WHERE joined."message_id" = "message"."id"),
	'[]'::jsonb
)
WHERE "message"."parts" @> '[{"type": "collaboration"}]';--> statement-breakpoint
-- The asking bot's turn after its helpers have answered is a hand-back, where
-- it was resumed once its collaboration ended. Turns asked for and not yet
-- finished carry their reason too.
UPDATE "turn" SET "reason" = 'hand_back' WHERE "reason" = 'resume';--> statement-breakpoint
UPDATE "lane" SET "payload" = jsonb_set("payload", '{reason}', '"hand_back"') WHERE "workflow" = 'turn' AND "payload"->>'reason' = 'resume';--> statement-breakpoint
UPDATE "lane_request" SET "payload" = jsonb_set("payload", '{reason}', '"hand_back"') WHERE "workflow" = 'turn' AND "payload"->>'reason' = 'resume';--> statement-breakpoint
-- Empty now, the collaboration chats go, and with them their read cursors,
-- compactions and the system chats serving them.
DELETE FROM "chat" WHERE "kind" = 'collaboration';--> statement-breakpoint
DROP TABLE "collaboration_move";--> statement-breakpoint
DROP VIEW "placed_chat";--> statement-breakpoint
DROP TABLE "collaboration";--> statement-breakpoint
ALTER TABLE "chat" DROP CONSTRAINT "chat_kind_valid", ADD CONSTRAINT "chat_kind_valid" CHECK ("kind" in ('project_chat', 'run', 'automation_feed', 'system_chat'));--> statement-breakpoint
-- The kind check names the kinds in its body, so it is made again.
CREATE OR REPLACE FUNCTION chat_has_kind_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	has_kind_row boolean;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM "chat" WHERE "id" = NEW."id") THEN
		RETURN NULL;
	END IF;
	has_kind_row := CASE NEW."kind"
		WHEN 'project_chat' THEN EXISTS (SELECT 1 FROM "project_chat" WHERE "chat_id" = NEW."id")
		WHEN 'run' THEN EXISTS (SELECT 1 FROM "run" WHERE "chat_id" = NEW."id")
		WHEN 'automation_feed' THEN EXISTS (SELECT 1 FROM "automation_feed" WHERE "chat_id" = NEW."id")
		WHEN 'system_chat' THEN EXISTS (SELECT 1 FROM "system_chat" WHERE "chat_id" = NEW."id")
		ELSE false
	END;
	IF NOT has_kind_row THEN
		RAISE EXCEPTION 'chat % is a % with no % row', NEW."id", NEW."kind", NEW."kind"
			USING ERRCODE = 'foreign_key_violation';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE VIEW "placed_chat" AS (select
	c.id, c.workspace_id, c.kind, c.title, c.created_at, c.updated_at,
	coalesce(p.default_of_bot_id, sc.bot_id) as bot_id,
	p.id as project_id,
	case c.kind
		when 'run' then rf.chat_id
		when 'system_chat' then null
		else c.id
	end as root_chat_id,
	sc.served_chat_id as parent_chat_id,
	cc.started_by_id,
	sc.system_bot_key,
	cc.resolved_at,
	f.automation_id
from "chat" c
left join "project_chat" cc on cc.chat_id = c.id
left join "run" r on r.chat_id = c.id
left join "automation_feed" rf on rf.automation_id = r.automation_id
left join "automation_feed" f on f.chat_id = c.id
left join "automation" a on a.id = coalesce(r.automation_id, f.automation_id)
left join "project" p on p.id = coalesce(cc.project_id, a.project_id)
left join "system_chat" sc on sc.chat_id = c.id);
