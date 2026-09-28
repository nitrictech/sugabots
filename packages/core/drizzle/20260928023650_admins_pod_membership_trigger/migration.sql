-- Serialises every write that decides whether an administrator is in a shared pod. Without it, a pod made while somebody is promoted is missed by both: each insert runs before the other commits.
CREATE FUNCTION lock_pod_membership(workspace uuid) RETURNS void
LANGUAGE sql AS $$
	SELECT pg_advisory_xact_lock(hashtext('pod_membership:' || workspace::text));
$$;--> statement-breakpoint

CREATE FUNCTION add_administrators_to_new_shared_pod() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_pod_membership(NEW."workspace_id");
	INSERT INTO "pod_member" ("workspace_id", "pod_id", "user_id")
	SELECT NEW."workspace_id", NEW."id", "user_id"
	FROM "workspace_member"
	WHERE "workspace_id" = NEW."workspace_id" AND "role" = 'admin'
	ON CONFLICT ("pod_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER shared_pod_administrators
AFTER INSERT ON "pod"
FOR EACH ROW WHEN (NEW."kind" = 'shared')
EXECUTE FUNCTION add_administrators_to_new_shared_pod();--> statement-breakpoint

-- Only adds: somebody demoted keeps the pods they are in, and leaves them one at a time.
CREATE FUNCTION add_new_administrator_to_shared_pods() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_pod_membership(NEW."workspace_id");
	INSERT INTO "pod_member" ("workspace_id", "pod_id", "user_id")
	SELECT NEW."workspace_id", "id", NEW."user_id"
	FROM "pod"
	WHERE "workspace_id" = NEW."workspace_id" AND "kind" = 'shared'
	ON CONFLICT ("pod_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER administrator_shared_pods
AFTER INSERT OR UPDATE OF "role" ON "workspace_member"
FOR EACH ROW WHEN (NEW."role" = 'admin')
EXECUTE FUNCTION add_new_administrator_to_shared_pods();
