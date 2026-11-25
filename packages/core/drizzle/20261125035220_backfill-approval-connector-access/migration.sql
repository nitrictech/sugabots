UPDATE "tool_call" AS call
SET "approval_connector_access" = 'ask'
FROM "connector" AS connector
WHERE connector."id" = call."connector_id"
	AND call."approval_status" IN ('pending', 'allowed')
	AND call."approval_connector_access" IS NULL
	AND COALESCE(
		connector."tool_access" ->> call."remote_tool_name",
		CASE WHEN (connector."kind" = 'http' AND call."remote_tool_name" = 'delete')
			OR (connector."kind" = 'github' AND call."remote_tool_name" = 'delete_comment')
			THEN 'off'
		END,
		(
			SELECT CASE
				WHEN described ->> 'destructive' = 'true' THEN 'off'
				WHEN described ->> 'readOnly' = 'true' THEN 'allow'
				ELSE 'ask'
			END
			FROM jsonb_array_elements(connector."tools") AS described
			WHERE connector."kind" = 'mcp' AND described ->> 'name' = call."remote_tool_name"
			LIMIT 1
		),
		CASE WHEN connector."kind" = 'mcp' AND call."remote_tool_name" = 'upload_file'
			AND connector."url" ~* '^https?://mcp[.]linear[.]app([/?#]|$)' THEN 'allow'
		END,
		CASE WHEN call."write_or_delete" THEN 'ask' ELSE 'allow' END
	) = 'ask';
--> statement-breakpoint
-- A legacy pending call's last update is when it parked, including if it parked again.
UPDATE "tool_call"
SET "approval_asked_at" = "updated_at"
WHERE "approval_status" = 'pending'
	AND "status" = 'awaiting_approval'
	AND "approval_asked_at" = "started_at"
	AND "updated_at" > "started_at";
