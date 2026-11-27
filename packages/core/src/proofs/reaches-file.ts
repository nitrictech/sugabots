import { BotCannotReach, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import {
	file,
	OPENABLE_CHAT_KINDS,
	placedChat,
	unsentAttachment,
	WRITTEN_FILE_KINDS,
} from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import {
	decideReach,
	type ProjectFacts,
	type ReachedAs,
	reachFacts,
	useTurnAdmission,
	whoActs,
} from "./facts.ts";
import type { IsMember } from "./is-member.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import { proveReachesChat } from "./reaches-chat.ts";

/**
 * The file F was uploaded or made in a chat P reaches, as `ReachesChat`
 * decides it for that chat. Found with the chat and its workspace, which
 * services take from here.
 */
export interface ReachesFile<P, F> extends Proof<"ReachesFile", [P, F]> {
	readonly principal: Named<P, Principal>;
	readonly file: Named<F, string>;
	/** The chat F was uploaded or made in. */
	readonly chat: string;
	/** F's workspace. */
	readonly workspace: string;
	/** The project F's chat is in. */
	readonly project: ProjectFacts;
	readonly as: ReachedAs;
}

const ReachesFileProof = defineProof("ReachesFile");

export const proveReachesFile = <P, F>(principal: Named<P, Principal>, fileId: Named<F, string>) =>
	proveFileWhere(principal, fileId);

export const proveReachesFileInChat = <P, C, F>(
	principal: Named<P, Principal>,
	chat: Named<C, string>,
	fileId: Named<F, string>,
) =>
	isUuid(chat.value)
		? proveFileWhere(principal, fileId, eq(file.chatId, chat.value))
		: Effect.fail(new ResourceHidden({ resource: "file" }));

export const proveReachesWrittenFile = <P, F>(
	principal: Named<P, Principal>,
	fileId: Named<F, string>,
) => proveFileWhere(principal, fileId, inArray(file.kind, [...WRITTEN_FILE_KINDS]));

const proveFileWhere = <P, F>(
	principal: Named<P, Principal>,
	fileId: Named<F, string>,
	matches?: SQL,
) =>
	Effect.gen(function* () {
		const acting = principal.value;
		const id = fileId.value.toLowerCase();
		const hidden = new ResourceHidden({ resource: "file" });
		const [found] = isUuid(id)
			? yield* query((db) =>
					db
						.select({ chat: file.chatId })
						.from(file)
						.where(and(eq(file.id, id), matches))
						.limit(1),
				)
			: [];
		if (!found) return yield* Effect.fail(hidden);
		const chatsProject = sql`(select ${placedChat.projectId} from ${placedChat} where ${placedChat.id} = ${found.chat}::uuid)`;
		const facts = yield* query((db) => reachFacts(db, chatsProject, whoActs(acting)));
		if (!facts) return yield* Effect.fail(hidden);
		const decision = decideReach(acting, facts, found.chat);
		if (decision.kind === "hidden") return yield* Effect.fail(hidden);
		if (decision.kind === "botCannotReach") {
			return yield* Effect.fail(new BotCannotReach({ resource: "file" }));
		}
		const proof: ReachesFile<P, F> = ReachesFileProof.prove([principal, fileId], {
			principal,
			file: fileId,
			chat: found.chat,
			workspace: facts.project.workspace,
			project: useTurnAdmission(acting, facts).project,
			as: decision.as,
		});
		return proof;
	});

export interface ReachesMessageFile<P, F> extends Proof<"ReachesMessageFile", [P, F]> {
	readonly chat: string;
}

export interface OwnsUnsentAttachment<P, F> extends Proof<"OwnsUnsentAttachment", [P, F]> {
	readonly chat: string;
	readonly uploader: string;
}

const ReachesMessageFileProof = defineProof("ReachesMessageFile");
const OwnsUnsentAttachmentProof = defineProof("OwnsUnsentAttachment");

export const proveReachesMessageFile = <P, C, F>(
	principal: Named<P, Principal>,
	chatId: Named<C, string>,
	fileId: Named<F, string>,
) =>
	Effect.gen(function* () {
		yield* checkFileInChat(principal, chatId, fileId, isNotNull(file.messageId));
		const proof: ReachesMessageFile<P, F> = ReachesMessageFileProof.prove([principal, fileId], {
			chat: chatId.value,
		});
		return proof;
	});

export const proveOwnsUnsentAttachment = <P, C, F>(
	isMember: IsMember<P>,
	chatId: Named<C, string>,
	fileId: Named<F, string>,
) =>
	Effect.gen(function* () {
		const { principal, member } = isMember;
		yield* checkFileInChat(
			principal,
			chatId,
			fileId,
			sql`${unsentAttachment} and ${eq(file.uploaderId, member)}`,
		);
		const proof: OwnsUnsentAttachment<P, F> = OwnsUnsentAttachmentProof.prove([principal, fileId], {
			chat: chatId.value,
			uploader: member,
		});
		return proof;
	});

const checkFileInChat = <P, C, F>(
	principal: Named<P, Principal>,
	chatId: Named<C, string>,
	fileId: Named<F, string>,
	matches: SQL,
) =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "file" });
		const id = fileId.value;
		if (!isUuid(id)) return yield* hidden;
		yield* proveReachesChat(
			principal,
			chatId,
			sql`${inArray(placedChat.kind, [...OPENABLE_CHAT_KINDS])}
				and exists (select 1 from ${file}
					where ${file.id} = ${id}::uuid and ${file.chatId} = ${placedChat.id} and ${matches})`,
		).pipe(Effect.mapError(() => hidden));
	});
