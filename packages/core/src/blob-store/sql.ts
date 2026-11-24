import { pgTable, text } from "drizzle-orm/pg-core";
import { primaryKey, stamp } from "../database/sql.ts";
import type { BlobStore } from "./blob-store.ts";

/**
 * Blobs to delete from the blob store, which `deletions.ts` works through. A
 * row is written in the same transaction as whatever made the blobs
 * unreachable, so the work survives a crash and is never queued for a delete
 * that rolled back.
 *
 * Rows come from database triggers as well as from code: deleting a
 * `chat` or a `file` a bot wrote, however it happens, queues its
 * folder (see the `chat_blob_deletion` trigger in the migration that
 * made the `chat` table, and the `file_blob_deletion` trigger in the
 * one that made the `file` table).
 */
export const blobDeletion = pgTable("blob_deletion", {
	id: primaryKey(),
	/** Every blob under this key goes. */
	prefix: text("prefix").$type<BlobStore.Key>().notNull(),
	queuedAt: stamp("queued_at"),
});

/**
 * Folders whose blobs a migration moved to another key, for the blob store
 * to move when the server starts, before it serves them: a migration can
 * reach a Postgres blob store's rows but not a filesystem store's disk, so
 * every store moves them itself (see `BlobStore.make`). A row goes once its
 * folder has moved.
 */
export const blobFolderMove = pgTable("blob_folder_move", {
	id: primaryKey(),
	/** Every blob under this key moves to the same key under `toPrefix`. */
	fromPrefix: text("from_prefix").$type<BlobStore.Key>().notNull(),
	toPrefix: text("to_prefix").$type<BlobStore.Key>().notNull(),
	queuedAt: stamp("queued_at"),
});
