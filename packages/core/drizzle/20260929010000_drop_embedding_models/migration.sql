-- No agent can run on an embedding model, so the workspace no longer lists them. One an admin switched the capability off for was declared a chat model, and stays.
DELETE FROM "provider_model"
WHERE "capabilities" @> '["embeddings"]' AND NOT "disabled_capabilities" @> '["embeddings"]';--> statement-breakpoint

UPDATE "provider_model"
SET "capabilities" = "capabilities" - 'embeddings', "disabled_capabilities" = "disabled_capabilities" - 'embeddings'
WHERE "capabilities" ? 'embeddings' OR "disabled_capabilities" ? 'embeddings';
