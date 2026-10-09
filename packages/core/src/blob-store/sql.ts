import { pgTable, text } from "drizzle-orm/pg-core";
import { primaryKey, stamp } from "../database/sql.ts";
import type { BlobStore } from "./blob-store.ts";

/**
 * Blobs to delete from the blob store, which `deletions.ts` works through. A
 * row is written in the same transaction as whatever made the blobs
 * unreachable, so the work survives a crash and is never queued for a delete
 * that rolled back.
 *
 * Rows come from database triggers as well as from code: deleting a `thread`,
 * however it happens, queues its folder (see the `thread_blob_deletion`
 * trigger in the `thread_files` migration).
 */
export const blobDeletion = pgTable("blob_deletion", {
	id: primaryKey(),
	/** Every blob under this key goes. */
	prefix: text("prefix").$type<BlobStore.Key>().notNull(),
	queuedAt: stamp("queued_at"),
});
