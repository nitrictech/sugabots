ALTER TABLE "pod" ADD COLUMN "color" text;--> statement-breakpoint
-- Each workspace's shared pods take the palette in turn, oldest first, as new pods would have.
UPDATE "pod" SET "color" = (ARRAY['green', 'blue', 'plum', 'amber', 'teal', 'purple', 'rose', 'orange'])[1 + ("ranked"."ordinal" - 1) % 8]
FROM (
	SELECT "id", row_number() OVER (PARTITION BY "workspace_id" ORDER BY "created_at", "id") AS "ordinal"
	FROM "pod"
	WHERE "kind" = 'shared'
) AS "ranked"
WHERE "pod"."id" = "ranked"."id";
