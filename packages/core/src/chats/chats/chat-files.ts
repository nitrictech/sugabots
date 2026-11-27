export * as ChatFiles from "./chat-files.ts";

import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "@sugabots/contracts";
import type { ChatFileNotFound } from "@sugabots/contracts/errors/chat-reads";
import type {
	FileTooLarge,
	TooManyUnsentAttachments,
	UploadInterrupted,
} from "@sugabots/contracts/errors/chats";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import type { InputOf, OutputOf } from "@sugabots/contracts/operations";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, type Stream } from "effect";
import { contentType as mediaTypeForName } from "mime-types";
import { query, serviceOperations } from "../../database/database.ts";
import { OPENABLE_CHAT_KINDS, turn } from "../../database/schema.ts";
import { ChatFileStore } from "../../files/chat-file-store.ts";
import type { Approved } from "../../proofs/approved.ts";
import type { IsMember } from "../../proofs/is-member.ts";
import type { CanTakePart } from "../../proofs/project-permissions.ts";
import type { Named } from "../../proofs/proof.ts";
import type {
	OwnsUnsentAttachment,
	ReachesFile,
	ReachesMessageFile,
} from "../../proofs/reaches-file.ts";
import { modelAcceptsImages } from "../../providers/model-providers/model-provider-reads.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { reachedChatOfKind } from "./reached-chat.ts";
import { readChatFileContent } from "./read-chat-file-content.ts";

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
	/** Removes a member's upload to the chat before it is sent. */
	readonly removeUnsentAttachment: <P, F>(
		file: Named<F, string>,
		owns: OwnsUnsentAttachment<P, F>,
	) => Effect.Effect<void>;
	/** Reads a file attached to a message in a chat the principal reaches. */
	readonly read: <P, F>(
		file: Named<F, string>,
		reach: ReachesMessageFile<P, F>,
	) => Effect.Effect<ChatFileStore.StoredFile, ChatFileNotFound>;
	readonly readForTurn: <P, F, X>(
		reach: ReachesFile<P, F>,
		input: Omit<InputOf<"chats.readChatFile">, "file" | "chat">,
		approved: Approved<P, X, [F], "chats.readChatFile">,
	) => Effect.Effect<OutputOf<"chats.readChatFile">, ResourceHidden>;
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

		removeUnsentAttachment: (file, owns) =>
			operation(
				"removeUnsentAttachment",
				files.removeUnsentAttachment({
					chatId: owns.chat,
					uploaderId: owns.uploader,
					fileId: file.value,
				}),
			),

		read: (file, reach) =>
			operation(
				"read",
				files
					.readMessageFile({ chatId: reach.chat, fileId: file.value })
					.pipe(Effect.catchTags(storeOutagesAsDefects)),
			),

		readForTurn: (reach, input, approved) =>
			operation(
				"readForTurn",
				readChatFileContent(
					files.read({ chatId: reach.chat, fileId: reach.file.value }),
					input,
					Effect.gen(function* () {
						const principal = approved.principal.value;
						if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun")
							return false;
						const [stored] = yield* query((db) =>
							db.select({ model: turn.model }).from(turn).where(eq(turn.id, principal.turn)),
						);
						return stored ? yield* modelAcceptsImages(reach.workspace, stored.model) : false;
					}),
				).pipe(Effect.catchTag("ChatFileNotFound", () => new ResourceHidden({ resource: "file" }))),
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
