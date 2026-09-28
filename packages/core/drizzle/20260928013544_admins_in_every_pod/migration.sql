-- Administrators used to reach every shared pod through their role. They are members of every one instead, so `pod_member` is the whole list of who is in a pod.
INSERT INTO "pod_member" ("workspace_id", "pod_id", "user_id")
SELECT "pod"."workspace_id", "pod"."id", "workspace_member"."user_id"
FROM "pod"
INNER JOIN "workspace_member"
	ON "workspace_member"."workspace_id" = "pod"."workspace_id"
	AND "workspace_member"."role" = 'admin'
WHERE "pod"."kind" = 'shared'
ON CONFLICT ("pod_id", "user_id") DO NOTHING;
