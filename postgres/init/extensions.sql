-- Drizzle does not manage extensions, so `bun run db:push` cannot create the
-- ones the schema's indexes need. Migrations create them too; this covers
-- databases built with push. Runs only when the data volume is first created.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
