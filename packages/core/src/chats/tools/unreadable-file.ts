import { type UserText, userText } from "@sugabots/errors";
import { Effect } from "effect";
import type { BlobStore } from "../../blob-store/blob-store.ts";
import type { ChatFileStore } from "../../files/chat-file-store.ts";

/**
 * What a bot is told when a file in its chat can't be read. A store that
 * refuses is set up wrong, which trying again won't fix, so that is logged.
 */
export function unreadableFileRefusal(
	failure: ChatFileStore.FileNotFound | BlobStore.Failure,
): Effect.Effect<UserText> {
	switch (failure._tag) {
		case "ChatFileNotFound":
			return Effect.succeed(userText`There is no file with that id in this chat.`);
		case "BlobStoreUnavailable":
			return Effect.succeed(userText`The file can't be read right now. Try again shortly.`);
		case "BlobStoreRejected":
			return Effect.as(
				Effect.logError("The blob store rejected reading a file", failure),
				userText`Files can't be read in this server.`,
			);
	}
}
