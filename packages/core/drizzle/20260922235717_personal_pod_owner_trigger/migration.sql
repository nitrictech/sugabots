CREATE FUNCTION enforce_personal_pod_owner_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "pod"
		WHERE "id" = NEW."pod_id"
			AND "kind" = 'personal'
			AND "owner_id" <> NEW."user_id"
	) THEN
		RAISE EXCEPTION 'Only the owner may belong to a personal pod';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER personal_pod_owner_membership
BEFORE INSERT OR UPDATE ON "pod_member"
FOR EACH ROW EXECUTE FUNCTION enforce_personal_pod_owner_membership();
