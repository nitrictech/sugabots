import type { FilePart } from "@sugabots/contracts";
import { asc, inArray } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { threadFile } from "../../database/schema.ts";

/**
 * Reading the files attached to messages back into the parts the API hands
 * out. A message does not list its files: each attached `thread_file` row
 * names its message. Writing them is `thread-files/thread-files.ts`.
 */

/** The columns a file part is read from, for a relational query. */
export const fileColumns = { id: true, name: true, contentType: true, size: true } as const;

/** An attached file, read with {@link fileColumns}. */
export interface AttachedFileRow {
	id: string;
	name: string | null;
	contentType: string;
	size: number;
}

export function toFilePart(row: AttachedFileRow): FilePart {
	return {
		type: "file",
		id: row.id,
		// The table's checks name every file on a message: an upload or an agent's attachment.
		name: row.name ?? "",
		contentType: row.contentType,
		size: row.size,
	};
}

/** The files on each of these messages, in their order on it, by message id. */
export const loadFileParts = Effect.fn("FileParts.loadFileParts")(function* (
	db: Executor,
	messageIds: readonly string[],
) {
	const byMessage = new Map<string, FilePart[]>();
	if (messageIds.length === 0) {
		return byMessage;
	}
	const rows = yield* db
		.select({
			messageId: threadFile.messageId,
			id: threadFile.id,
			name: threadFile.name,
			contentType: threadFile.contentType,
			size: threadFile.size,
		})
		.from(threadFile)
		.where(inArray(threadFile.messageId, [...messageIds]))
		.orderBy(asc(threadFile.position));
	for (const { messageId, ...row } of rows) {
		if (messageId === null) continue;
		byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), toFilePart(row)]);
	}
	return byMessage;
});
