export * as Artifacts from "./artifacts.ts";

import type {
	Artifact,
	ArtifactAuthor,
	ArtifactKind,
	ArtifactSummary,
	ArtifactVersionSummary,
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
} from "../database/schema.ts";
import { Ids, isUuid } from "../ids/ids.ts";
import { replaceSection } from "./document-sections.ts";

/**
 * Reading a pod's artifacts, for people. Seeing them takes `pod.read`, the
 * same reach that shows the pod's conversations.
 */
export interface Interface {
	readonly list: (
		at: InPod,
	) => Effect.Effect<ArtifactSummary[], AuthorizationDenied, CurrentActor.Service>;
	/** The artifact at its current version. */
	readonly get: (
		at: InArtifact,
	) => Effect.Effect<Artifact, AuthorizationDenied, CurrentActor.Service>;
	/** Its versions, newest first. */
	readonly versions: (
		at: InArtifact,
	) => Effect.Effect<ArtifactVersionSummary[], AuthorizationDenied, CurrentActor.Service>;
	readonly getVersion: (
		at: InArtifact & { version: number },
	) => Effect.Effect<Artifact, AuthorizationDenied, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Artifacts") {}

/**
 * Making and changing artifacts, for an agent's tools. An agent reaches the
 * artifacts of its own pod and no other. Every change names the version it
 * was based on and is refused with `ArtifactStale` if another landed first,
 * so one writer never silently overwrites another.
 */
export interface AuthoringInterface {
	readonly list: (by: AgentInPod) => Effect.Effect<ArtifactSummary[]>;
	readonly read: (by: AgentInPod, artifactId: string) => Effect.Effect<Artifact, ArtifactNotFound>;
	readonly create: (
		by: AgentInThread,
		input: { kind: ArtifactKind; title: string; content: string },
	) => Effect.Effect<Artifact>;
	readonly replace: (
		by: AgentInPod,
		input: { artifactId: string; baseVersion: number; content: string; title?: string },
	) => Effect.Effect<Artifact, ArtifactNotFound | ArtifactStale>;
	/** Replaces one heading's section of a document, heading line included. */
	readonly replaceSection: (
		by: AgentInPod,
		input: { artifactId: string; baseVersion: number; heading: string; content: string },
	) => Effect.Effect<Artifact, ArtifactNotFound | ArtifactStale | SectionNotFound | NotADocument>;
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
			const versionId = yield* ids.next;
			const key = versionKey(artifactId, versionId);
			const contentType = CONTENT_TYPES[kind];
			// A spike: the store failing, or the content being over its limit, ends the call.
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
				() => new ArtifactNotFound({ artifactId }),
			),
		);

	/** Writes `content` as the version after `baseVersion`, if that is still the current one. */
	const writeVersion = (
		by: AgentInPod,
		found: FoundArtifact,
		baseVersion: number,
		changes: { stored: StoredContent; title?: string },
	) =>
		Effect.gen(function* () {
			const current = found.artifact.currentVersion;
			if (baseVersion !== current) {
				return yield* new ArtifactStale({ currentVersion: current });
			}
			const number = current + 1;
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
					if (!shown) return yield* new ArtifactNotFound({ artifactId });
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

		replace: (by, { artifactId, baseVersion, content, title }) =>
			operation(
				"replace",
				Effect.gen(function* () {
					const before = yield* requireArtifact(by, artifactId, { lock: false });
					const written = yield* withContent(
						before.artifact.id,
						before.artifact.kind,
						content,
						(stored) =>
							transaction(
								Effect.flatMap(requireArtifact(by, artifactId), (found) =>
									writeVersion(by, found, baseVersion, { stored, ...(title ? { title } : {}) }),
								),
							),
					);
					return { ...written, content };
				}),
			),

		replaceSection: (by, { artifactId, baseVersion, heading, content }) =>
			operation(
				"replaceSection",
				Effect.gen(function* () {
					const before = yield* requireArtifact(by, artifactId, { lock: false });
					if (before.artifact.kind !== "document") return yield* new NotADocument();
					// The section is replaced in the content as read here, outside the
					// write, so the write refuses it if another version lands meanwhile.
					if (baseVersion !== before.artifact.currentVersion) {
						return yield* new ArtifactStale({ currentVersion: before.artifact.currentVersion });
					}
					const current = yield* atVersion(before, before.artifact.currentVersion);
					const replaced = replaceSection(current?.content ?? "", heading, content);
					if (!replaced.ok) {
						return yield* new SectionNotFound({
							reason: replaced.reason,
							headings: replaced.headings,
						});
					}
					const markdown = replaced.markdown;
					const written = yield* withContent(before.artifact.id, "document", markdown, (stored) =>
						transaction(
							Effect.flatMap(requireArtifact(by, artifactId), (found) =>
								writeVersion(by, found, baseVersion, { stored }),
							),
						),
					);
					return { ...written, content: markdown };
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(Authorization.layer));

export const authoringLayer = Layer.effect(Authoring, makeAuthoring);

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

export class ArtifactNotFound extends Data.TaggedError("ArtifactNotFound")<{
	readonly artifactId: string;
}> {}

/** Another version landed after the one a change was based on. */
export class ArtifactStale extends Data.TaggedError("ArtifactStale")<{
	readonly currentVersion: number;
}> {}

export class SectionNotFound extends Data.TaggedError("SectionNotFound")<{
	readonly reason: "missing" | "ambiguous";
	readonly headings: string[];
}> {}

/** Sections are a document's; an HTML page is replaced whole. */
export class NotADocument extends Data.TaggedError("NotADocument") {}

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
		// A row is never without its blob, as a write puts the blob first. A
		// spike: the store being unreachable ends the call.
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
