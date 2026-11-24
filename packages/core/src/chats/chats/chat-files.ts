export * as ChatFiles from "./chat-files.ts";

import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "@sugabots/contracts";
import type { ChatFileNotFound } from "@sugabots/contracts/errors/chat-reads";
import type {
	FileTooLarge,
	TooManyUnsentAttachments,
	UploadInterrupted,
} from "@sugabots/contracts/errors/chats";
import type { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Context, Effect, Layer, type Stream } from "effect";
import { contentType as mediaTypeForName } from "mime-types";
import { serviceOperations } from "../../database/database.ts";
import { OPENABLE_CHAT_KINDS } from "../../database/schema.ts";
import { ChatFileStore } from "../../files/chat-file-store.ts";
import type { IsMember } from "../../proofs/is-member.ts";
import type { CanTakePart } from "../../proofs/project-permissions.ts";
import type { ReachesChat } from "../../proofs/reaches-chat.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { reachedChatOfKind } from "./reached-chat.ts";

/**
 * Files members attach to messages in a chat, kept in its chat. Anyone
 * who takes part in a chat members open can upload to it, and anyone who
 * reaches it read what was attached there. The blob store failing to keep
 * or open a file is the server's fault, not the member's: a defect. A file's
 * bytes fail as `ChatFileStore.StoredFile`'s do.
 */
export interface Interface {
	/**
	 * Keeps `stream` as an unsent attachment the member can put on a message
	 * they send to the chat `canTakePart` is about, as `type`, or, when that is
	 * missing or says only that it is bytes, as the type its name suggests.
	 * Fails with `FileTooLarge` past `MAX_ATTACHMENT_BYTES`, or below it past
	 * what the chat keeps, and with `TooManyUnsentAttachments` once the member
	 * has a message's worth unsent.
	 */
	readonly upload: <P, C>(
		isMember: IsMember<P>,
		canTakePart: CanTakePart<P, C>,
		file: {
			name: string;
			type: string | undefined;
			stream: Stream.Stream<Uint8Array, UploadInterrupted>;
		},
	) => Effect.Effect<
		ChatFileStore.UnsentAttachment,
		ResourceHidden | FileTooLarge | TooManyUnsentAttachments | UploadInterrupted
	>;
	/**
	 * Removes `fileId` when it is one of the member's unsent attachments to
	 * the chat `reach` is about, such as one taken off the message they are
	 * writing. Anything else is left as it is.
	 */
	readonly removeUnsentAttachment: <P, C>(
		isMember: IsMember<P>,
		reach: ReachesChat<P, C>,
		fileId: string,
	) => Effect.Effect<void, ResourceHidden>;
	/**
	 * A file attached to a message in the chat `reach` is about. Any other
	 * file in its chat, such as an unsent attachment or a tool call's result,
	 * is not found.
	 */
	readonly read: <P, C>(
		reach: ReachesChat<P, C>,
		fileId: string,
	) => Effect.Effect<ChatFileStore.StoredFile, ResourceHidden | ChatFileNotFound>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ChatFiles") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ChatFiles");
	const files = yield* ChatFileStore.Service;

	return Service.of({
		upload: (isMember, canTakePart, { name, type, stream }) =>
			operation(
				"upload",
				Effect.gen(function* () {
					const chat = yield* reachedChatOfKind(canTakePart.reach, OPENABLE_CHAT_KINDS);
					return yield* files.upload({
						chatId: chat.id,
						uploaderId: isMember.member,
						name,
						maxSize: MAX_ATTACHMENT_BYTES,
						maxUnsent: MAX_ATTACHMENTS_PER_MESSAGE,
						content: { stream, contentType: mediaTypeOf(name, type) },
					});
				}).pipe(Effect.catchTags(storeOutagesAsDefects)),
			),

		removeUnsentAttachment: (isMember, reach, fileId) =>
			operation(
				"removeUnsentAttachment",
				Effect.gen(function* () {
					const chat = yield* reachedChatOfKind(reach, OPENABLE_CHAT_KINDS);
					yield* files.removeUnsentAttachment({
						chatId: chat.id,
						uploaderId: isMember.member,
						fileId,
					});
				}),
			),

		read: (reach, fileId) =>
			operation(
				"read",
				Effect.gen(function* () {
					const chat = yield* reachedChatOfKind(reach, OPENABLE_CHAT_KINDS);
					return yield* files.readMessageFile({ chatId: chat.id, fileId });
				}).pipe(Effect.catchTags(storeOutagesAsDefects)),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide(ChatFileStore.layer));

/**
 * A blob store that cannot be reached, or refuses, is the server's fault, not
 * the member's: logged in full, and answered as a defect.
 */
const storeOutagesAsDefects = {
	BlobStoreUnavailable: Effect.die,
	BlobStoreRejected: Effect.die,
} as const;

/** What a browser calls a file whose type it does not know. */
const UNKNOWN_MEDIA_TYPE = "application/octet-stream";

/**
 * `declared`, unless it is missing or only says the file is bytes: browsers
 * report no type for many text files, such as Markdown or source code, which
 * bots could then not read as text.
 */
function mediaTypeOf(name: string, declared: string | undefined): string {
	if (declared !== undefined && declared !== UNKNOWN_MEDIA_TYPE) return declared;
	return mediaTypeForName(name) || UNKNOWN_MEDIA_TYPE;
}
