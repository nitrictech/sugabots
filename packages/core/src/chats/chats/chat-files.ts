export * as ChatFiles from "./chat-files.ts";

import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "@sugabots/contracts";
import { Context, Effect, Layer, type Stream } from "effect";
import { contentType as mediaTypeForName } from "mime-types";
import type { ResourceHidden } from "../../authorization/access.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import type { BlobStore } from "../../blob-store/blob-store.ts";
import { serviceOperations } from "../../database/database.ts";
import { ChatFileStore } from "../../files/chat-file-store.ts";

/**
 * Files members attach to messages in a chat, kept in its chat.
 * Anyone who can see the chat can upload to it, and read what was attached there.
 */
export interface Interface {
	/**
	 * Keeps `stream` as an unsent attachment the actor can put on a message they send
	 * to the chat, as `type`, or, when that is missing or says only that it is
	 * bytes, as the type its name suggests. Fails with `FileTooLarge` past
	 * `MAX_ATTACHMENT_BYTES`, or below it past what the chat keeps, and with
	 * `TooManyUnsentAttachments` once the actor has a message's worth unsent.
	 */
	readonly upload: <E>(input: {
		chatId: string;
		name: string;
		type: string | undefined;
		stream: Stream.Stream<Uint8Array, E>;
	}) => Effect.Effect<
		ChatFileStore.UnsentAttachment,
		| E
		| ResourceHidden
		| ChatFileStore.FileTooLarge
		| ChatFileStore.TooManyUnsentAttachments
		| BlobStore.Failure,
		CurrentActor.Service
	>;
	/**
	 * Removes one of the actor's unsent attachments to the chat, such as
	 * one taken off the message they are writing. Anything else is left as it is.
	 */
	readonly removeUnsentAttachment: (input: {
		chatId: string;
		fileId: string;
	}) => Effect.Effect<void, ResourceHidden, CurrentActor.Service>;
	/**
	 * A file attached to a message in the chat. Any other file in its chat,
	 * such as an unsent attachment or a tool call's result, is not found.
	 */
	readonly read: (input: {
		chatId: string;
		fileId: string;
	}) => Effect.Effect<
		ChatFileStore.StoredFile,
		ResourceHidden | ChatFileStore.FileNotFound | BlobStore.Failure,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ChatFiles") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ChatFiles");
	const visibility = yield* Visibility.Service;
	const files = yield* ChatFileStore.Service;

	return Service.of({
		upload: ({ chatId, name, type, stream }) =>
			operation(
				"upload",
				Effect.gen(function* () {
					const chat = yield* visibility.chat(chatId);
					const { memberId } = yield* CurrentActor.Service;
					return yield* files.upload({
						chatId: chat.id,
						uploaderId: memberId,
						name,
						maxSize: MAX_ATTACHMENT_BYTES,
						maxUnsent: MAX_ATTACHMENTS_PER_MESSAGE,
						content: { stream, contentType: mediaTypeOf(name, type) },
					});
				}),
			),
		removeUnsentAttachment: ({ chatId, fileId }) =>
			operation(
				"removeUnsentAttachment",
				Effect.gen(function* () {
					const chat = yield* visibility.chat(chatId);
					const { memberId } = yield* CurrentActor.Service;
					yield* files.removeUnsentAttachment({
						chatId: chat.id,
						uploaderId: memberId,
						fileId,
					});
				}),
			),
		read: ({ chatId, fileId }) =>
			operation(
				"read",
				Effect.flatMap(visibility.chat(chatId), (chat) =>
					files.readMessageFile({ chatId: chat.id, fileId }),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Visibility.layer, ChatFileStore.layer]));

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
