export * as Artifacts from "./artifacts.ts";

import {
	type Artifact,
	type ArtifactAuthor,
	type ArtifactKind,
	type ArtifactSummary,
	type ArtifactVersionSummary,
	MAX_ARTIFACT_CONTENT_CHARACTERS,
} from "@sugabots/contracts";
import { and, desc, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer, Stream } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
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
} from "../database/schema.ts";
import { Ids, isUuid } from "../ids/ids.ts";

/**
 * Reading a pod's artifacts, for people. Seeing them takes `pod.read`, the
 * same reach that shows the pod's conversations; deleting one takes
 * `pod.update`, held by those who manage the pod.
 */
export interface Interface {
	readonly list: (
		at: InPod,
	) => Effect.Effect<ArtifactSummary[], AuthorizationDenied, CurrentActor.Service>;
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
 * Making and changing artifacts, for an agent's tools. An agent reaches the
 * artifacts of its own pod and no other. Every change names the version it
 * was based on and is refused with `Stale` if another landed first,
 * so one writer never silently overwrites another.
 */
export interface AuthoringInterface {
	readonly list: (by: AgentInPod) => Effect.Effect<ArtifactSummary[]>;
	readonly read: (by: AgentInPod, artifactId: string) => Effect.Effect<Artifact, NotFound>;
	readonly create: (
		by: AgentInThread,
		input: { kind: ArtifactKind; title: string; content: string },
	) => Effect.Effect<Artifact, TooLarge>;
	readonly replace: (
		by: AgentInPod,
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
		by: AgentInPod,
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
	const blobs = yield* BlobStore.Service;
	const atVersion = atVersionIn(blobs);

	const inReachedPod = (podId: string, artifactId: string) =>
		Effect.gen(function* () {
			yield* authorization.pod(podId, "pod.read");
			const found = yield* artifactIn(podId, artifactId);
			if (!found) return yield* new ResourceHidden({ resource: "artifact" });
			return found;
		});

	return Service.of({
		list: ({ podId }) =>
			operation(
				"list",
				Effect.flatMap(authorization.pod(podId, "pod.read"), () => summariesIn(podId)),
			),

		get: ({ podId, artifactId }) =>
			operation(
				"get",
				Effect.gen(function* () {
					const found = yield* inReachedPod(podId, artifactId);
					return yield* shownOrHidden(atVersion(found, found.artifact.currentVersion));
				}),
			),

		summary: ({ podId, artifactId }) =>
			operation(
				"summary",
				Effect.map(inReachedPod(podId, artifactId), (found) =>
					toSummary(found.artifact, found.creator),
				),
			),

		versions: ({ podId, artifactId }) =>
			operation(
				"versions",
				Effect.flatMap(inReachedPod(podId, artifactId), ({ artifact: row }) => versionsOf(row.id)),
			),

		getVersion: ({ podId, artifactId, version }) =>
			operation(
				"getVersion",
				Effect.gen(function* () {
					const found = yield* inReachedPod(podId, artifactId);
					return yield* shownOrHidden(atVersion(found, version));
				}),
			),

		remove: ({ podId, artifactId }) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const { artifact: row } = yield* inReachedPod(podId, artifactId);
					yield* authorization.pod(podId, "pod.update");
					// The versions go with it, and the `artifact_blob_deletion` trigger queues its blobs.
					yield* query((db) => db.delete(artifact).where(eq(artifact.id, row.id)));
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

	const requireArtifact = (by: AgentInPod, artifactId: string, { lock = true } = {}) =>
		artifactIn(by.podId, artifactId, { lock }).pipe(
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
		by: AgentInPod,
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
		list: (by) => operation("list", summariesIn(by.podId)),

		read: (by, artifactId) =>
			operation(
				"read",
				Effect.gen(function* () {
					const found = yield* artifactIn(by.podId, artifactId);
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
											podId: by.podId,
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

export const layer = layerNoDeps.pipe(Layer.provide(Authorization.layer));

export const authoringLayer = Layer.effect(Authoring, makeAuthoring);

/**
 * Version `version` of an artifact in `podId`, read without asking who wants
 * it: only for a caller that has already authorized the read, as a sealed
 * page address has (see `pages.ts`). `undefined` when there is no such
 * artifact or version.
 */
export const readVersionUnchecked =
	(blobs: BlobStore.Interface) => (podId: string, artifactId: string, version: number) =>
		Effect.gen(function* () {
			const found = yield* artifactIn(podId, artifactId);
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

export interface InPod {
	podId: string;
}

export interface InArtifact extends InPod {
	artifactId: string;
}

/** The agent a tool acts for, and the pod whose artifacts it reaches. */
export interface AgentInPod {
	workspaceId: string;
	podId: string;
	agentId: string;
}

/** An agent in the thread it is working in, which a new artifact records it was made in. */
export interface AgentInThread extends AgentInPod {
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

const artifactIn = (podId: string, artifactId: string, options: { lock?: boolean } = {}) =>
	Effect.gen(function* () {
		if (!isUuid(artifactId)) return undefined;
		const [row] = yield* query((db) => {
			const select = db
				.select({ artifact, creator: { id: agent.id, name: agent.name } })
				.from(artifact)
				.leftJoin(agent, eq(agent.id, artifact.createdByAgentId))
				.where(and(eq(artifact.id, artifactId), eq(artifact.podId, podId)))
				.limit(1);
			return options.lock ? select.for("update", { of: artifact }) : select;
		});
		return row ? { artifact: row.artifact, creator: authorOf(row.creator) } : undefined;
	});

const summariesIn = (podId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ artifact, creator: { id: agent.id, name: agent.name } })
				.from(artifact)
				.leftJoin(agent, eq(agent.id, artifact.createdByAgentId))
				.where(eq(artifact.podId, podId))
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
	podId: row.podId,
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
