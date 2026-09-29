CREATE UNIQUE INDEX "workspace_member_owner_idx" ON "workspace_member" ("workspace_id") WHERE "role" = 'owner';--> statement-breakpoint
ALTER TABLE "workspace_member" DROP CONSTRAINT "workspace_member_role_check", ADD CONSTRAINT "workspace_member_role_check" CHECK ("role" in ('owner', 'admin', 'member', 'viewer'));--> statement-breakpoint

-- Every workspace gets the owner it has always had in practice: the administrator who has been in it longest, who is its creator unless they have since stepped down.
UPDATE "workspace_member" SET "role" = 'owner'
WHERE "id" IN (
	SELECT DISTINCT ON ("admin"."workspace_id") "admin"."id"
	FROM "workspace_member" AS "admin"
	WHERE "admin"."role" = 'admin'
		AND NOT EXISTS (
			SELECT 1 FROM "workspace_member" AS "owner"
			WHERE "owner"."workspace_id" = "admin"."workspace_id" AND "owner"."role" = 'owner'
		)
	ORDER BY "admin"."workspace_id", "admin"."created_at", "admin"."id"
);--> statement-breakpoint

-- The owner administers every shared pod as an admin does, so both triggers from `admins_in_every_pod` count them in.
CREATE OR REPLACE FUNCTION add_administrators_to_new_shared_pod() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_pod_membership(NEW."workspace_id");
	INSERT INTO "pod_member" ("workspace_id", "pod_id", "user_id")
	SELECT NEW."workspace_id", NEW."id", "user_id"
	FROM "workspace_member"
	WHERE "workspace_id" = NEW."workspace_id" AND "role" IN ('owner', 'admin')
	ON CONFLICT ("pod_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint

DROP TRIGGER "administrator_shared_pods" ON "workspace_member";--> statement-breakpoint

CREATE TRIGGER administrator_shared_pods
AFTER INSERT OR UPDATE OF "role" ON "workspace_member"
FOR EACH ROW WHEN (NEW."role" IN ('owner', 'admin'))
EXECUTE FUNCTION add_new_administrator_to_shared_pods();
