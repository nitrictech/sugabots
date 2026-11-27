import type { ChatKind } from "@sugabots/contracts";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import { placedChat } from "../../database/schema.ts";
import type { ReachesChat } from "../../proofs/reaches-chat.ts";

/**
 * The chat `reach` is about, in its workspace, when it is one of `kinds`;
 * otherwise hidden, as a chat the principal asks nothing of. A member reaches a
 * run's chat as they do its feed, but posts only in the chats they open.
 */
export const reachedChatOfKind = <P, C>(reach: ReachesChat<P, C>, kinds: readonly ChatKind[]) =>
	Effect.gen(function* () {
		const [chat] = yield* query((db) =>
			db
				.select()
				.from(placedChat)
				.where(
					and(
						eq(placedChat.id, reach.chat.value),
						eq(placedChat.workspaceId, reach.workspace),
						inArray(placedChat.kind, [...kinds]),
					),
				)
				.limit(1),
		);
		if (!chat) return yield* new ResourceHidden({ resource: "chat" });
		return chat;
	});
