export * as Artifacts from "./artifacts.ts";

import type {
	Artifact,
	ArtifactAuthor,
	ArtifactKind,
	ArtifactSummary,
	ArtifactVersionSummary,
} from "@sugabots/contracts";
import { and, desc, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { query, serviceOperations, transaction, writtenRow } from "../database/database.ts";
import {
	type AgentRow,
	type ArtifactRow,
	type ArtifactVersionRow,
	agent,
	artifact,
	artifactVersion,
} from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
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

	const requireArtifact = (by: AgentInPod, artifactId: string) =>
		artifactIn(by.podId, artifactId, { lock: true }).pipe(
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
		changes: { content: string; title?: string },
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
			const version = yield* insertVersion(found.artifact.id, number, changes.content, by.agentId);
			return toArtifact(
				{ artifact: updated, creator: found.creator },
				version,
				yield* agentNamed(by.agentId),
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
				transaction(
					Effect.gen(function* () {
						const row = yield* query((db) =>
							db
								.insert(artifact)
								.values({
									workspaceId: by.workspaceId,
									podId: by.podId,
									kind: input.kind,
									title: input.title,
									createdByAgentId: by.agentId,
									createdInThreadId: by.threadId,
								})
								.returning(),
						).pipe(Effect.flatMap(writtenRow("artifact")));
						const version = yield* insertVersion(row.id, 1, input.content, by.agentId);
						const author = yield* agentNamed(by.agentId);
						return toArtifact({ artifact: row, creator: author }, version, author);
					}),
				),
			),

		replace: (by, { artifactId, baseVersion, content, title }) =>
			operation(
				"replace",
				transaction(
					Effect.flatMap(requireArtifact(by, artifactId), (found) =>
						writeVersion(by, found, baseVersion, { content, ...(title ? { title } : {}) }),
					),
				),
			),

		replaceSection: (by, { artifactId, baseVersion, heading, content }) =>
			operation(
				"replaceSection",
				transaction(
					Effect.gen(function* () {
						const found = yield* requireArtifact(by, artifactId);
						if (found.artifact.kind !== "document") return yield* new NotADocument();
						const current = yield* versionRow(found.artifact.id, found.artifact.currentVersion);
						const replaced = replaceSection(current?.content ?? "", heading, content);
						if (!replaced.ok) {
							return yield* new SectionNotFound({
								reason: replaced.reason,
								headings: replaced.headings,
							});
						}
						return yield* writeVersion(by, found, baseVersion, { content: replaced.markdown });
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(Authorization.layer));

export const authoringLayer = Layer.effect(Authoring, makeAuthoring);

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
const atVersion = (found: FoundArtifact, number: number) =>
	Effect.map(versionRow(found.artifact.id, number), (version) =>
		version ? toArtifact(found, version, version.author) : undefined,
	);

const shownOrHidden = <E, R>(shown: Effect.Effect<Artifact | undefined, E, R>) =>
	shown.pipe(
		Effect.filterOrFail(
			(artifact) => artifact !== undefined,
			() => new ResourceHidden({ resource: "artifact" }),
		),
	);

const insertVersion = (artifactId: string, number: number, content: string, agentId: string) =>
	query((db) =>
		db
			.insert(artifactVersion)
			.values({ artifactId, number, content, authorAgentId: agentId })
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
): Artifact => ({
	...toSummary(found.artifact, found.creator),
	content: version.content,
	shownVersion: toVersionSummary(version, author),
});
