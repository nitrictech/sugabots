export * as Artifacts from "./artifacts.ts";

import {
	type Artifact,
	type ArtifactAuthor,
	type ArtifactKind,
	type ArtifactSummary,
	type ArtifactVersionSummary,
	MAX_ARTIFACT_CONTENT_CHARACTERS,
	type ThreadType,
} from "@sugabots/contracts";
import { and, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Data, Effect, Layer, Stream } from "effect";
import {
	ActionForbidden,
	type AuthorizationDenied,
	ResourceHidden,
} from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { Visibility } from "../authorization/visibility.ts";
import { BlobStore } from "../blob-store/blob-store.ts";
import { query, serviceOperations, transaction, writtenRow } from "../database/database.ts";
import {
	type AgentRow,
	type ArtifactRow,
	type ArtifactVersionRow,
	agent,
	artifact,
	artifactVersion,
	blobDeletion,
	thread,
} from "../database/schema.ts";
import { Ids, isUuid } from "../ids/ids.ts";

/**
 * Reading the files bots made, for people. A file is reached through the
 * conversation it was made in: a channel's by the people in the channel, a
 * bot's by whoever reaches the bot. One made in a collaboration or an
 * automation's run belongs to the conversation that was opened from. Deleting
 * one takes changing the channel or the bot.
 */
export interface Interface {
	/** The files bots made in the channel's conversations, and what was opened from them, newest change first. */
	readonly listInPod: (input: {
		podId: string;
	}) => Effect.Effect<ArtifactSummary[], AuthorizationDenied, CurrentActor.Service>;
	/**
	 * The files made in the bot's own tasks and automation feeds, and what was
	 * opened from them, newest change first: not those it made in a channel or
	 * when another bot asked it.
	 */
	readonly listForAgent: (input: {
		agentId: string;
	}) => Effect.Effect<ArtifactSummary[], AuthorizationDenied, CurrentActor.Service>;
	/** The artifact at its current version. */
	readonly get: (
		at: InArtifact,
	) => Effect.Effect<Artifact, AuthorizationDenied, CurrentActor.Service>;
	/** What the artifact is, without reading its content. */
	readonly summary: (
		at: InArtifact,
	) => Effect.Effect<ArtifactSummary, AuthorizationDenied, CurrentActor.Service>;
	/** Its versions, newest first. */
	readonly versions: (
		at: InArtifact,
	) => Effect.Effect<ArtifactVersionSummary[], AuthorizationDenied, CurrentActor.Service>;
	readonly getVersion: (
		at: InArtifact & { version: number },
	) => Effect.Effect<Artifact, AuthorizationDenied, CurrentActor.Service>;
	/** Deletes the artifact with every version of it; its stored content is removed after. */
	readonly remove: (
		at: InArtifact,
	) => Effect.Effect<void, AuthorizationDenied, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Artifacts") {}

/**
 * Making and changing files, for a bot's tools. A bot reaches the files made
 * in the conversation it is working in, and what was opened from it; in a
 * channel's conversation, every file made in the channel; and in its own task
 * or automation feed, every file made in its own tasks and feeds, which
 * whoever reaches the bot sees. Never the files it made elsewhere, which the
 * people of the conversation it is working in may not see. Every change names
 * the version it was based on and is refused with `Stale` if another landed
 * first, so one writer never silently overwrites another.
 */
export interface AuthoringInterface {
	readonly list: (by: AgentInThread) => Effect.Effect<ArtifactSummary[]>;
	readonly read: (by: AgentInThread, artifactId: string) => Effect.Effect<Artifact, NotFound>;
	readonly create: (
		by: AgentInThread,
		input: { kind: ArtifactKind; title: string; content: string },
	) => Effect.Effect<Artifact, TooLarge>;
	readonly replace: (
		by: AgentInThread,
		input: {
			artifactId: string;
			baseVersion: number;
			content: string;
			title?: string;
			/** Write over `baseVersion` instead of after it, as when the same reply wrote it. */
			inPlace?: boolean;
			/** What the writer takes the artifact to be; refused with `KindFixed` if it is another kind. */
			kind?: ArtifactKind;
		},
	) => Effect.Effect<Artifact, NotFound | Stale | KindFixed | TooLarge>;
	/**
	 * Replaces the one place `oldText` appears in the current content with
	 * `newText`, as a new version, so a small change needn't resend the rest.
	 */
	readonly edit: (
		by: AgentInThread,
		input: {
			artifactId: string;
			baseVersion: number;
			oldText: string;
			newText: string;
			/** Write over `baseVersion` instead of after it, as when the same reply wrote it. */
			inPlace?: boolean;
		},
	) => Effect.Effect<Artifact, NotFound | Stale | EditTextUnmatched | TooLarge>;
}

export class Authoring extends Context.Service<Authoring, AuthoringInterface>()(
	"@sugabots/core/Artifacts/Authoring",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Artifacts");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;
	const blobs = yield* BlobStore.Service;
	const atVersion = atVersionIn(blobs);

	/** The file, once the actor reaches the conversation it was made in, with their standing there. */
	const inReachedThread = (artifactId: string) =>
		Effect.gen(function* () {
			const found = yield* artifactWithId(artifactId);
			if (!found) return yield* new ResourceHidden({ resource: "artifact" });
			const standing = yield* visibility
				.thread(found.artifact.createdInThreadId)
				.pipe(Effect.mapError(() => new ResourceHidden({ resource: "artifact" })));
			return { found, standing };
		});

	return Service.of({
		listInPod: ({ podId }) =>
			operation(
				"listInPod",
				Effect.flatMap(authorization.pod(podId, "pod.read"), () =>
					summariesWhere(eq(madeInConversation.podId, podId)),
				),
			),

		listForAgent: ({ agentId }) =>
			operation(
				"listForAgent",
				Effect.flatMap(authorization.agent(agentId, "agent.read"), () =>
					summariesWhere(madeInOwnConversationOf(agentId)),
				),
			),

		get: ({ artifactId }) =>
			operation(
				"get",
				Effect.gen(function* () {
					const { found } = yield* inReachedThread(artifactId);
					return yield* shownOrHidden(atVersion(found, found.artifact.currentVersion));
				}),
			),

		summary: ({ artifactId }) =>
			operation(
				"summary",
				Effect.map(inReachedThread(artifactId), ({ found }) =>
					toSummary(found.artifact, found.creator),
				),
			),

		versions: ({ artifactId }) =>
			operation(
				"versions",
				Effect.flatMap(inReachedThread(artifactId), ({ found }) => versionsOf(found.artifact.id)),
			),

		getVersion: ({ artifactId, version }) =>
			operation(
				"getVersion",
				Effect.gen(function* () {
					const { found } = yield* inReachedThread(artifactId);
					return yield* shownOrHidden(atVersion(found, version));
				}),
			),

		remove: ({ artifactId }) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const { found, standing } = yield* inReachedThread(artifactId);
					const mayRemove =
						standing.kind === "pod"
							? standing.standing.may("pod.update")
							: standing.kind === "agent" && standing.standing.may("agent.update");
					if (!mayRemove) {
						return yield* new ActionForbidden({
							permission: standing.kind === "pod" ? "pod.update" : "agent.update",
						});
					}
					// The versions go with it, and the `artifact_blob_deletion` trigger queues its blobs.
					yield* query((db) => db.delete(artifact).where(eq(artifact.id, found.artifact.id)));
				}),
			),
	});
});

export const makeAuthoring = Effect.gen(function* () {
	const operation = yield* serviceOperations<AuthoringInterface>("Artifacts.Authoring");
	const blobs = yield* BlobStore.Service;
	const ids = yield* Ids.Service;
	const atVersion = atVersionIn(blobs);

	/**
	 * Puts `content` in the blob store as a new version of `artifactId`, then
	 * runs `record` to write its rows. The blob goes first so a row is never
	 * without its blob; if `record` fails, the blob is removed, and if that
	 * fails too, it goes with the artifact's folder.
	 */
	const withContent = <A, E, R>(
		artifactId: string,
		kind: ArtifactKind,
		content: string,
		record: (stored: StoredContent) => Effect.Effect<A, E, R>,
	) =>
		Effect.gen(function* () {
			if (content.length > MAX_ARTIFACT_CONTENT_CHARACTERS) {
				return yield* new TooLarge({ maxCharacters: MAX_ARTIFACT_CONTENT_CHARACTERS });
			}
			const versionId = yield* ids.next;
			const key = versionKey(artifactId, versionId);
			const contentType = CONTENT_TYPES[kind];
			// Content under the limit above is far under any store's, so its `TooLarge`
			// can't happen. A store that can't be reached is an infrastructure fault:
			// the agent's tool reports that its call failed.
			const { size } = yield* blobs
				.put(key, { stream: Stream.succeed(new TextEncoder().encode(content)), contentType })
				.pipe(Effect.orDie);
			return yield* record({ versionId, contentType, size }).pipe(
				Effect.onError(() => blobs.delete(key).pipe(Effect.ignore)),
			);
		});

	const requireArtifact = (by: AgentInThread, artifactId: string, { lock = true } = {}) =>
		artifactReachedBy(by, artifactId, { lock }).pipe(
			Effect.filterOrFail(
				(found) => found !== undefined,
				() => new NotFound({ artifactId }),
			),
		);

	/**
	 * Writes `content` as the version after `baseVersion`, or `inPlace` of it,
	 * if that is still the current one. A version written over keeps its
	 * number; its old content's blob is queued for deletion.
	 */
	const writeVersion = (
		by: AgentInThread,
		found: FoundArtifact,
		baseVersion: number,
		changes: { stored: StoredContent; title?: string; inPlace?: boolean },
	) =>
		Effect.gen(function* () {
			const current = found.artifact.currentVersion;
			if (baseVersion !== current) {
				return yield* new Stale({ currentVersion: current });
			}
			if (changes.inPlace) yield* removeVersion(found.artifact.id, current);
			const number = changes.inPlace ? current : current + 1;
			const updated = yield* query((db) =>
				db
					.update(artifact)
					.set({ currentVersion: number, ...(changes.title ? { title: changes.title } : {}) })
					.where(eq(artifact.id, found.artifact.id))
					.returning(),
			).pipe(Effect.flatMap(writtenRow("artifact")));
			const version = yield* insertVersion(found.artifact.id, number, changes.stored, by.agentId);
			return toArtifact(
				{ artifact: updated, creator: found.creator },
				version,
				yield* agentNamed(by.agentId),
				"",
			);
		});

	return Authoring.of({
		list: (by) =>
			operation(
				"list",
				Effect.flatMap(conversationOf(by.threadId), (working) =>
					summariesWhere(reachedByAgent(by.agentId, working)),
				),
			),

		read: (by, artifactId) =>
			operation(
				"read",
				Effect.gen(function* () {
					const found = yield* artifactReachedBy(by, artifactId);
					const shown = found && (yield* atVersion(found, found.artifact.currentVersion));
					if (!shown) return yield* new NotFound({ artifactId });
					return shown;
				}),
			),

		create: (by, input) =>
			operation(
				"create",
				Effect.flatMap(ids.next, (artifactId) =>
					withContent(artifactId, input.kind, input.content, (stored) =>
						transaction(
							Effect.gen(function* () {
								const row = yield* query((db) =>
									db
										.insert(artifact)
										.values({
											id: artifactId,
											workspaceId: by.workspaceId,
											kind: input.kind,
											title: input.title,
											createdByAgentId: by.agentId,
											createdInThreadId: by.threadId,
										})
										.returning(),
								).pipe(Effect.flatMap(writtenRow("artifact")));
								const version = yield* insertVersion(row.id, 1, stored, by.agentId);
								const author = yield* agentNamed(by.agentId);
								return toArtifact(
									{ artifact: row, creator: author },
									version,
									author,
									input.content,
								);
							}),
						),
					),
				),
			),

		replace: (by, { artifactId, baseVersion, content, title, inPlace, kind }) =>
			operation(
				"replace",
				Effect.gen(function* () {
					const before = yield* requireArtifact(by, artifactId, { lock: false });
					if (kind && kind !== before.artifact.kind) {
						return yield* new KindFixed({ kind: before.artifact.kind });
					}
					const written = yield* withContent(
						before.artifact.id,
						before.artifact.kind,
						content,
						(stored) =>
							transaction(
								Effect.flatMap(requireArtifact(by, artifactId), (found) =>
									writeVersion(by, found, baseVersion, {
										stored,
										inPlace,
										...(title ? { title } : {}),
									}),
								),
							),
					);
					return { ...written, content };
				}),
			),

		edit: (by, { artifactId, baseVersion, oldText, newText, inPlace }) =>
			operation(
				"edit",
				// The edit is made to the content as it is under the artifact's lock: an
				// edit written in place keeps the version's number, so two edits to it
				// would both pass the version check, and one made to content read
				// before the lock would undo the other.
				transaction(
					Effect.gen(function* () {
						const found = yield* requireArtifact(by, artifactId);
						if (baseVersion !== found.artifact.currentVersion) {
							return yield* new Stale({ currentVersion: found.artifact.currentVersion });
						}
						const current = (yield* atVersion(found, found.artifact.currentVersion))?.content ?? "";
						const matches = current.split(oldText).length - 1;
						if (oldText === "" || matches !== 1) return yield* new EditTextUnmatched({ matches });
						// A function, so `$` in the new text is never read as a replacement pattern.
						const edited = current.replace(oldText, () => newText);
						const written = yield* withContent(
							found.artifact.id,
							found.artifact.kind,
							edited,
							(stored) => writeVersion(by, found, baseVersion, { stored, inPlace }),
						);
						return { ...written, content: edited };
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, Visibility.layer]));

export const authoringLayer = Layer.effect(Authoring, makeAuthoring);

/**
 * Version `version` of a file, read without asking who wants it: only for a
 * caller that has already authorized the read, as a sealed page address has
 * (see `pages.ts`). `undefined` when there is no such file or version.
 */
export const readVersionUnchecked =
	(blobs: BlobStore.Interface) => (artifactId: string, version: number) =>
		Effect.gen(function* () {
			const found = yield* artifactWithId(artifactId);
			if (!found) return undefined;
			return yield* atVersionIn(blobs)(found, version);
		});

/** A version's content as kept in the blob store. */
interface StoredContent {
	versionId: string;
	contentType: string;
	/** In bytes. */
	size: number;
}

const CONTENT_TYPES: Record<ArtifactKind, string> = {
	document: "text/markdown; charset=utf-8",
	html: "text/html; charset=utf-8",
};

/**
 * Under the artifact's folder, `artifacts/<artifactId>`, which the
 * `artifact_blob_deletion` trigger queues for deletion with the artifact.
 */
function versionKey(artifactId: string, versionId: string): BlobStore.Key {
	return BlobStore.key("artifacts", artifactId, "versions", versionId);
}

export interface InArtifact {
	artifactId: string;
}

/** The bot a tool acts for, in the thread it is working in, which a new file records it was made in. */
export interface AgentInThread {
	workspaceId: string;
	agentId: string;
	threadId: string;
}

export class NotFound extends Data.TaggedError("ArtifactNotFound")<{
	readonly artifactId: string;
}> {}

/** Another version landed after the one a change was based on. */
export class Stale extends Data.TaggedError("ArtifactStale")<{
	readonly currentVersion: number;
}> {}

/** A write took the artifact for another kind than the one it is, which never changes. */
export class KindFixed extends Data.TaggedError("ArtifactKindFixed")<{
	readonly kind: ArtifactKind;
}> {}

/** Content would be over `maxCharacters`, the most an artifact holds. */
export class TooLarge extends Data.TaggedError("ArtifactTooLarge")<{
	readonly maxCharacters: number;
}> {}

/** An edit's text appears in the artifact `matches` times, not exactly once. */
export class EditTextUnmatched extends Data.TaggedError("EditTextUnmatched")<{
	readonly matches: number;
}> {}

interface FoundArtifact {
	artifact: ArtifactRow;
	creator: ArtifactAuthor;
}

const authorOf = (row: Pick<AgentRow, "id" | "name"> | null): ArtifactAuthor =>
	row ? { agentId: row.id, name: row.name } : null;

/** The file `artifactId` where `scope` holds of it and the conversation it was made in. */
const artifactWhere = (
	artifactId: string,
	scope: SQL | undefined,
	options: { lock?: boolean } = {},
) =>
	Effect.gen(function* () {
		if (!isUuid(artifactId)) return undefined;
		const [row] = yield* query((db) => {
			const select = db
				.select({ artifact, creator: { id: agent.id, name: agent.name } })
				.from(artifact)
				.innerJoin(thread, eq(thread.id, artifact.createdInThreadId))
				.innerJoin(madeInConversation, conversationOfMadeIn)
				.leftJoin(agent, eq(agent.id, artifact.createdByAgentId))
				.where(and(eq(artifact.id, artifactId), scope))
				.limit(1);
			return options.lock ? select.for("update", { of: artifact }) : select;
		});
		return row ? { artifact: row.artifact, creator: authorOf(row.creator) } : undefined;
	});

const artifactWithId = (artifactId: string) => artifactWhere(artifactId, undefined);

/**
 * The conversation a file was made in, joined beside `thread`, the thread it
 * was made in: that thread itself, or for a collaboration or an automation's
 * run, the conversation it was opened from.
 */
const madeInConversation = alias(thread, "made_in_conversation");
const conversationOfMadeIn = eq(
	madeInConversation.id,
	sql`coalesce(${thread.conversationId}, ${thread.id})`,
);

/** A bot's own conversations: its tasks and automation feeds, which whoever reaches it sees. */
const OWN_CONVERSATION_TYPES = ["conversation", "routine_feed"] as const satisfies ThreadType[];

/** Files made in `agentId`'s own tasks and automation feeds, and what was opened from them. */
const madeInOwnConversationOf = (agentId: string) =>
	and(
		eq(madeInConversation.hostAgentId, agentId),
		inArray(madeInConversation.type, [...OWN_CONVERSATION_TYPES]),
	);

/** The conversation a bot is working in, by the thread its turn is in. */
interface WorkingConversation {
	id: string;
	type: ThreadType;
	podId: string | null;
	hostAgentId: string | null;
}

/** The files a bot working in `working` reaches: see `AuthoringInterface`. */
const reachedByAgent = (agentId: string, working: WorkingConversation | undefined): SQL => {
	if (!working) return sql`false`;
	const isOwn =
		working.hostAgentId === agentId &&
		(OWN_CONVERSATION_TYPES as readonly ThreadType[]).includes(working.type);
	return (
		or(
			eq(madeInConversation.id, working.id),
			working.podId === null ? undefined : eq(madeInConversation.podId, working.podId),
			isOwn ? madeInOwnConversationOf(agentId) : undefined,
		) ?? sql`false`
	);
};

/** The conversation the thread `threadId` belongs to: itself, or the one it was opened from. */
const conversationOf = (threadId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({
					id: madeInConversation.id,
					type: madeInConversation.type,
					podId: madeInConversation.podId,
					hostAgentId: madeInConversation.hostAgentId,
				})
				.from(thread)
				.innerJoin(madeInConversation, conversationOfMadeIn)
				.where(eq(thread.id, threadId))
				.limit(1),
		),
		([row]): WorkingConversation | undefined => row,
	);

const artifactReachedBy = (
	by: AgentInThread,
	artifactId: string,
	options: { lock?: boolean } = {},
) =>
	Effect.flatMap(conversationOf(by.threadId), (working) =>
		artifactWhere(artifactId, reachedByAgent(by.agentId, working), options),
	);

const summariesWhere = (scope: SQL | undefined) =>
	Effect.map(
		query((db) =>
			db
				.select({ artifact, creator: { id: agent.id, name: agent.name } })
				.from(artifact)
				.innerJoin(thread, eq(thread.id, artifact.createdInThreadId))
				.innerJoin(madeInConversation, conversationOfMadeIn)
				.leftJoin(agent, eq(agent.id, artifact.createdByAgentId))
				.where(scope)
				.orderBy(desc(artifact.updatedAt)),
		),
		(rows) => rows.map((row) => toSummary(row.artifact, authorOf(row.creator))),
	);

const versionsOf = (artifactId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ version: artifactVersion, author: { id: agent.id, name: agent.name } })
				.from(artifactVersion)
				.leftJoin(agent, eq(agent.id, artifactVersion.authorAgentId))
				.where(eq(artifactVersion.artifactId, artifactId))
				.orderBy(desc(artifactVersion.number)),
		),
		(rows) => rows.map((row) => toVersionSummary(row.version, authorOf(row.author))),
	);

const versionRow = (artifactId: string, number: number) =>
	Effect.map(
		query((db) =>
			db
				.select({ version: artifactVersion, author: { id: agent.id, name: agent.name } })
				.from(artifactVersion)
				.leftJoin(agent, eq(agent.id, artifactVersion.authorAgentId))
				.where(and(eq(artifactVersion.artifactId, artifactId), eq(artifactVersion.number, number)))
				.limit(1),
		),
		([row]) => row && { ...row.version, author: authorOf(row.author) },
	);

/** The artifact as of version `number`, or `undefined` when it has no such version. */
const atVersionIn = (blobs: BlobStore.Interface) => (found: FoundArtifact, number: number) =>
	Effect.gen(function* () {
		const version = yield* versionRow(found.artifact.id, number);
		if (!version) return undefined;
		// A row is never without its blob, as a write puts the blob first. A store
		// that can't be reached is an infrastructure fault, which a person's
		// request answers as a server error and an agent's tool as a failed call.
		const stored = yield* blobs.get(versionKey(found.artifact.id, version.id)).pipe(Effect.orDie);
		const content = yield* Stream.mkString(Stream.decodeText(stored.stream)).pipe(Effect.orDie);
		return toArtifact(found, version, version.author, content);
	});

const shownOrHidden = <E, R>(shown: Effect.Effect<Artifact | undefined, E, R>) =>
	shown.pipe(
		Effect.filterOrFail(
			(artifact) => artifact !== undefined,
			() => new ResourceHidden({ resource: "artifact" }),
		),
	);

const insertVersion = (
	artifactId: string,
	number: number,
	{ versionId, contentType, size }: StoredContent,
	agentId: string,
) =>
	query((db) =>
		db
			.insert(artifactVersion)
			.values({ id: versionId, artifactId, number, contentType, size, authorAgentId: agentId })
			.returning(),
	).pipe(Effect.flatMap(writtenRow("artifact_version")));

/** Deletes version `number` of the artifact, queueing its content's blob for deletion. */
const removeVersion = (artifactId: string, number: number) =>
	Effect.gen(function* () {
		const removed = yield* query((db) =>
			db
				.delete(artifactVersion)
				.where(and(eq(artifactVersion.artifactId, artifactId), eq(artifactVersion.number, number)))
				.returning({ id: artifactVersion.id }),
		);
		if (removed.length === 0) return;
		yield* query((db) =>
			db
				.insert(blobDeletion)
				.values(removed.map(({ id }) => ({ prefix: versionKey(artifactId, id) }))),
		);
	});

const agentNamed = (agentId: string) =>
	Effect.map(
		query((db) =>
			db.select({ id: agent.id, name: agent.name }).from(agent).where(eq(agent.id, agentId)),
		),
		([row]) => authorOf(row ?? null),
	);

const toSummary = (row: ArtifactRow, creator: ArtifactAuthor): ArtifactSummary => ({
	id: row.id,
	threadId: row.createdInThreadId,
	kind: row.kind,
	title: row.title,
	version: row.currentVersion,
	createdBy: creator,
	createdAt: row.createdAt.toISOString(),
	updatedAt: row.updatedAt.toISOString(),
});

const toVersionSummary = (
	row: ArtifactVersionRow,
	author: ArtifactAuthor,
): ArtifactVersionSummary => ({
	number: row.number,
	author,
	createdAt: row.createdAt.toISOString(),
});

const toArtifact = (
	found: FoundArtifact,
	version: ArtifactVersionRow,
	author: ArtifactAuthor,
	content: string,
): Artifact => ({
	...toSummary(found.artifact, found.creator),
	content,
	shownVersion: toVersionSummary(version, author),
});
