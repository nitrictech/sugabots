import { bytea, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { stamp, updatedStamp } from "../../database/sql.ts";
import type { BlobStore } from "../blob-store.ts";

/**
 * Bytes kept under a key, for the Postgres blob store. See `postgres.ts`.
 *
 * Postgres compresses large values and keeps them outside the row, so a query
 * that leaves `bytes` out never reads them.
 */
export const blob = pgTable(
	"blob",
	{
		key: text("key").$type<BlobStore.Key>().primaryKey(),
		bytes: bytea("bytes").notNull(),
		contentType: text("content_type").notNull(),
		size: integer("size").notNull(),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	// The primary key's collation-aware ordering cannot serve `LIKE 'prefix%'`.
	(table) => [index("blob_key_prefix_idx").on(table.key.op("text_pattern_ops"))],
);
