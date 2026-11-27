export * as Artifacts from "./artifacts.ts";

import { createHash } from "node:crypto";
import {
	type Artifact,
	type ArtifactAuthor,
	type ArtifactImageType,
	type ArtifactKind,
	type ArtifactSummary,
	type ArtifactVersionSummary,
	imageTypeOf,
	isEditedLive,
	MAX_ARTIFACT_CONTENT_CHARACTERS,
	MAX_ARTIFACT_IMAGE_BYTES,
	MAX_ARTIFACT_IMAGES_BYTES,
} from "@sugabots/contracts";
import { htmlOfDeck, readDeckHtml } from "@sugabots/contracts/deck-html";
import { type ArtifactImageIds, artifactImageIds } from "@sugabots/contracts/http";
import { userText } from "@sugabots/errors";
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
import { sizeForPeople, type UserFacing } from "../user-message.ts";
import { readHtml } from "./html-reader.ts";
import { LiveDocuments } from "./live.ts";
import type { Refused, TextRefused } from "./suggestions.ts";

/**
 * Reading a pod's artifacts, for people, and keeping the images a document
 * or deck shows. Seeing them takes `pod.read`, the same reach that shows the
 * pod's conversations; deleting one takes `pod.update`, held by those who
 * manage the pod.
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
	/**
	 * Keeps `stream` as an image for a `document` or `slides` artifact to show,
	 * and answers the ids it is addressed by. Anyone who can read the document
	 * can, as anyone who can read it can edit it. The image's id is its bytes'
	 * digest, so the same image kept again is kept once, and answers the same
	 * ids. Keeping nothing, fails with `ImageTooLarge` past
	 * `MAX_ARTIFACT_IMAGE_BYTES` or what the blob store keeps, with
	 * `ImageNotOfType` when its bytes aren't an image of `contentType`, with
	 * `ImagesFull` when the document's images would come to more than
	 * `MAX_ARTIFACT_IMAGES_BYTES`, and with whatever `stream` fails with.
	 * Uploads at the same moment may each pass that check, so it bounds them
	 * only roughly.
	 */
	readonly uploadImage: <E>(
		at: InArtifact & { contentType: ArtifactImageType; stream: Stream.Stream<Uint8Array, E> },
	) => Effect.Effect<
		ArtifactImageIds,
		E | AuthorizationDenied | ImageTooLarge | ImageNotOfType | ImagesFull | BlobStore.Failure,
		CurrentActor.Service
	>;
	/**
	 * An image kept for a `document` or `slides` artifact, for anyone who can
	 * read it. Fails with `ImageNotFound` for an id it keeps no image under.
	 */
	readonly image: (
		at: ArtifactImageIds,
	) => Effect.Effect<
		BlobStore.Blob,
		AuthorizationDenied | ImageNotFound | BlobStore.Failure,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Artifacts") {}

/**
 * Making and changing artifacts, for an agent's tools. An agent reaches the
 * artifacts of its own pod and no other. Every change names the version it
 * was based on and is refused with `Stale` if another landed first,
 * so one writer never silently overwrites another.
 *
 * A `document`'s content is markdown, and a `slides` deck's is HTML (see
 * `deck-html.ts`), which is read when an agent writes it and kept as the deck
 * it reads as, refused with `DeckHtmlRefused` when it says nothing or can't
 * be read whole. One people have opened in the editor is live (see
 * `live.ts`): its content is what the live document holds, an agent's change
 * is made to that, and the version the change writes is the live document's
 * text after it, people's edits included; a change that leaves it reading as
 * it did writes none and is refused as `Unchanged`. A change made in a
 * thread somebody started by asking for an edit from inside the document
 * writes no version and is refused as `Suggested`: it waits in the document
 * as one suggestion, its words and how a deck looks alike, for one of the
 * people there to accept or reject. Only a box it moves in front of or
 * behind another is moved at once, as a suggestion can't hold that.
 */
export interface AuthoringInterface {
	readonly list: (by: AgentInPod) => Effect.Effect<ArtifactSummary[]>;
	readonly read: (
		by: AgentInPod,
		artifactId: string,
	) => Effect.Effect<Artifact, NotFound | Unreadable>;
	readonly create: (
		by: AgentInThread,
		input: { kind: ArtifactKind; title: string; content: string },
	) => Effect.Effect<Artifact, TooLarge | DeckHtmlRefused>;
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
	) => Effect.Effect<Artifact, NotFound | Stale | KindFixed | TooLarge | NotWritten>;
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
	) => Effect.Effect<Artifact, NotFound | Stale | EditTextUnmatched | TooLarge | NotWritten>;
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

	/** The artifact edited live, if the person may read it: who may, may edit it and its images. */
	const readableLiveArtifact = (podId: string, artifactId: string) =>
		Effect.gen(function* () {
			const { artifact: row } = yield* inReachedPod(podId, artifactId);
			if (!isEditedLive(row)) return yield* new ResourceHidden({ resource: "artifact" });
			return row;
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

		uploadImage: ({ podId, artifactId, contentType, stream }) =>
			operation(
				"uploadImage",
				Effect.gen(function* () {
					const document = yield* readableLiveArtifact(podId, artifactId);
					// Read whole, as its id is the digest of its bytes; never more than an image may be.
					const chunks = yield* Stream.runCollect(
						BlobStore.atMost(stream, MAX_ARTIFACT_IMAGE_BYTES),
					).pipe(
						Effect.catchIf(isTooLarge, ({ maxSize }) =>
							Effect.fail(new ImageTooLarge({ maxSize })),
						),
					);
					const bytes = Buffer.concat(chunks);
					// It is served as `contentType`, so its bytes must be that kind of image and nothing else.
					if (imageTypeOf(bytes) !== contentType) {
						return yield* new ImageNotOfType({ contentType });
					}
					const image = imageIdsOf(document, bytes);
					const kept = yield* blobs.list(imagesFolder(document.id));
					if (kept.some((entry) => entry.key === imageKey(image))) return image;
					const keptBytes = kept.reduce((total, entry) => total + entry.size, 0);
					if (keptBytes + bytes.byteLength > MAX_ARTIFACT_IMAGES_BYTES) {
						return yield* new ImagesFull({ maxSize: MAX_ARTIFACT_IMAGES_BYTES });
					}
					yield* blobs
						.put(imageKey(image), { stream: Stream.succeed(bytes), contentType })
						.pipe(
							Effect.catchIf(isTooLarge, ({ maxSize }) =>
								Effect.fail(new ImageTooLarge({ maxSize })),
							),
						);
					return image;
				}),
			),

		image: (image) =>
			operation(
				"image",
				Effect.gen(function* () {
					yield* readableLiveArtifact(image.podId, image.artifactId);
					return yield* blobs
						.get(imageKey(image))
						.pipe(
							Effect.catchTag("BlobNotFound", () =>
								Effect.fail(new ImageNotFound({ imageId: image.imageId })),
							),
						);
				}),
			),
	});
});

export const makeAuthoring = Effect.gen(function* () {
	const operation = yield* serviceOperations<AuthoringInterface>("Artifacts.Authoring");
	const blobs = yield* BlobStore.Service;
	const ids = yield* Ids.Service;
	const live = yield* LiveDocuments.Service;
	const atVersion = atVersionIn(blobs);

	/** The artifact with what its live document holds, when it has one. */
	const withLiveContent = (shown: Artifact) =>
		isEditedLive(shown)
			? live.textForAgents(shown.id).pipe(
					Effect.map((text) => (text === undefined ? shown : { ...shown, content: text })),
					Effect.catchTag("LiveDocumentUnreadable", () => Effect.fail(new Unreadable())),
				)
			: Effect.succeed(shown);

	/** How people in a live document see the agent's change signed. */
	const authorOfChange = (by: AgentInThread) =>
		query((db) =>
			db
				.select({ name: agent.name, color: agent.color, face: agent.face, shape: agent.shape })
				.from(agent)
				.where(eq(agent.id, by.agentId)),
		).pipe(
			Effect.flatMap(([row]) =>
				row
					? Effect.succeed({
							name: row.name,
							threadId: by.threadId,
							look: { color: row.color, face: row.face, shape: row.shape },
						})
					: Effect.die(new Error(`Agent ${by.agentId} changed a document but has no row`)),
			),
		);

	/**
	 * Puts `content` in the blob store as a new version of `artifactId`, then
	 * runs `record` to write its rows. The blob goes first so a row is never
	 * without its blob; if `record` fails, the blob is removed, and if that
	 * fails too, it goes with the artifact's folder.
	 */
	const withContent = <A, E, R>(
		artifactId: string,
		kind: ArtifactKind,
		content: VersionText,
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

	/**
	 * The text of the version that `content` replacing `found`'s writes: the
	 * live document's own after the change, where it is live; otherwise
	 * `content` read as the artifact's kind (`versionTextOf`). Fails with why
	 * no version is written, as for a deck whose HTML says what it does
	 * already.
	 */
	const replacementText = (
		by: AgentInThread,
		found: FoundArtifact,
		baseVersion: number,
		content: string,
	) =>
		Effect.gen(function* () {
			const { artifact: row } = found;
			if (isEditedLive(row)) {
				// Checked again under the lock. Here it keeps a stale write out of the live document.
				if (baseVersion !== row.currentVersion) {
					return yield* new Stale({ currentVersion: row.currentVersion });
				}
				const rewritten = yield* live.rewrite(row.id, yield* authorOfChange(by), () => content);
				if (rewritten) return yield* versionOfLive(rewritten, row.kind);
			}
			const text = yield* versionTextOf(row.kind, content);
			// A deck's HTML is kept in one form, so the same deck is the same text.
			if (
				row.kind === "slides" &&
				text === (yield* atVersion(found, row.currentVersion))?.content
			) {
				return yield* new Unchanged({ kind: row.kind });
			}
			return text;
		});

	/**
	 * The text of the version that replacing the one place `oldText` appears
	 * in `found`'s content with `newText` writes: the live document's own
	 * after the change, where it is live; otherwise the current version's
	 * content so changed, read as the artifact's kind (`versionTextOf`). Fails
	 * with `EditTextUnmatched` when `oldText` isn't there exactly once, and
	 * with why no version is written for any other change that writes none.
	 */
	const editedText = (by: AgentInThread, found: FoundArtifact, oldText: string, newText: string) =>
		Effect.gen(function* () {
			const { artifact: row } = found;
			const inLive = isEditedLive(row)
				? yield* live.rewrite(row.id, yield* authorOfChange(by), (text) =>
						replacedOnce(text, oldText, newText),
					)
				: undefined;
			if (inLive) {
				// Left as it was, it may be that the edit's text isn't in it exactly once.
				if (inLive.outcome === "unchanged" && occurrences(inLive.text, oldText) !== 1) {
					return yield* new EditTextUnmatched({ matches: occurrences(inLive.text, oldText) });
				}
				return yield* versionOfLive(inLive, row.kind);
			}
			const current = (yield* atVersion(found, row.currentVersion))?.content ?? "";
			const edited = replacedOnce(current, oldText, newText);
			if (edited === undefined) {
				return yield* new EditTextUnmatched({ matches: occurrences(current, oldText) });
			}
			const text = yield* versionTextOf(row.kind, edited);
			// A deck's HTML is kept in one form, so the same deck is the same text.
			if (row.kind === "slides" && text === current)
				return yield* new Unchanged({ kind: row.kind });
			return text;
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
					return yield* withLiveContent(shown);
				}),
			),

		create: (by, input) =>
			operation(
				"create",
				Effect.gen(function* () {
					const text = yield* versionTextOf(input.kind, input.content);
					const artifactId = yield* ids.next;
					return yield* withContent(artifactId, input.kind, text, (stored) =>
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
								return toArtifact({ artifact: row, creator: author }, version, author, text);
							}),
						),
					);
				}),
			),

		replace: (by, { artifactId, baseVersion, content, title, inPlace, kind }) =>
			operation(
				"replace",
				Effect.gen(function* () {
					const before = yield* requireArtifact(by, artifactId, { lock: false });
					if (kind && kind !== before.artifact.kind) {
						return yield* new KindFixed({ kind: before.artifact.kind });
					}
					const text = yield* replacementText(by, before, baseVersion, content);
					const written = yield* withContent(
						before.artifact.id,
						before.artifact.kind,
						text,
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
					return { ...written, content: text };
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
						const text = yield* editedText(by, found, oldText, newText);
						const written = yield* withContent(
							found.artifact.id,
							found.artifact.kind,
							text,
							(stored) => writeVersion(by, found, baseVersion, { stored, inPlace }),
						);
						return { ...written, content: text };
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(Authorization.layer));

export const authoringLayer = Layer.effect(Authoring, makeAuthoring).pipe(
	Layer.provide(LiveDocuments.layer),
);

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

declare const versionTextMade: unique symbol;

/**
 * The text a version of an artifact keeps: a deck's HTML as `htmlOfDeck`
 * writes it, so that it is what the deck opens as, or a document's markdown
 * or a page's HTML. Only `versionTextOf`, which reads what an agent wrote,
 * and `versionOfLive`, which takes a live document's own text, make one, so a
 * deck's HTML is never kept as an agent wrote it.
 */
type VersionText = string & { readonly [versionTextMade]: true };

/**
 * `content`, as an agent wrote it for an artifact of `kind`, as the text a
 * version keeps: a deck's HTML read and written again as `htmlOfDeck` writes
 * it, and a document's markdown or a page's HTML as it is. Fails with
 * `DeckHtmlRefused` for a deck's HTML that says nothing or can't be read
 * whole, which would make the deck empty or lose some of it.
 */
function versionTextOf(
	kind: ArtifactKind,
	content: string,
): Effect.Effect<VersionText, DeckHtmlRefused> {
	if (kind !== "slides") return Effect.succeed(content as VersionText);
	const reading = readDeckHtml(content, readHtml);
	switch (reading.outcome) {
		case "deck":
			return Effect.succeed(htmlOfDeck(reading.deck) as VersionText);
		case "nothing":
			return Effect.fail(new DeckHtmlRefused({ reason: "saysNothing" }));
		case "unreadable":
			return Effect.fail(new DeckHtmlRefused({ reason: reading.reason }));
	}
}

/**
 * The text a version keeps of a live document an agent's change was made
 * to: the document's own, as the change left it. Fails with why no version
 * is written when the change wrote nothing a version would keep.
 */
function versionOfLive(
	rewritten: LiveDocuments.Rewritten,
	kind: ArtifactKind,
): Effect.Effect<VersionText, NotWritten> {
	switch (rewritten.outcome) {
		case "written":
			return Effect.succeed(rewritten.text as VersionText);
		case "unchanged":
			return Effect.fail(new Unchanged({ kind }));
		case "suggested":
			return Effect.fail(new Suggested());
		case "blocked":
			return Effect.fail(whyBlocked(rewritten.blocked));
	}
}

/** Why a change to a live document was blocked, as the failure the agent hears. */
function whyBlocked(
	blocked: Refused | "unreadable",
): Unreadable | SuggestionBlocked | DeckHtmlRefused {
	switch (blocked) {
		case "unreadable":
			return new Unreadable();
		case "unmarkable":
			return new SuggestionBlocked();
		default:
			return new DeckHtmlRefused({ reason: blocked });
	}
}

/** How many times `text` appears in `content`. */
const occurrences = (content: string, text: string) =>
	text === "" ? 0 : content.split(text).length - 1;

/** `content` with the one place `oldText` appears replaced, or `undefined` if it isn't there exactly once. */
const replacedOnce = (content: string, oldText: string, newText: string) =>
	occurrences(content, oldText) === 1
		? // A function, so `$` in the new text is never read as a replacement pattern.
			content.replace(oldText, () => newText)
		: undefined;

/** A version's content as kept in the blob store. */
interface StoredContent {
	versionId: string;
	contentType: string;
	/** In bytes. */
	size: number;
}

const CONTENT_TYPES: Record<ArtifactKind, string> = {
	document: "text/markdown; charset=utf-8",
	slides: "text/html; charset=utf-8",
	html: "text/html; charset=utf-8",
};

/**
 * Under the artifact's folder, `artifacts/<artifactId>`, which the
 * `artifact_blob_deletion` trigger queues for deletion with the artifact.
 */
function versionKey(artifactId: string, versionId: string): BlobStore.Key {
	return BlobStore.key("artifacts", artifactId, "versions", versionId);
}

/** Under the artifact's folder too, so its images are deleted with it, as its versions are. */
function imageKey({ artifactId, imageId }: ArtifactImageIds): BlobStore.Key {
	return BlobStore.key("artifacts", artifactId, "images", imageId);
}

/** Where every image an artifact keeps is, to count them by. */
function imagesFolder(artifactId: string): BlobStore.Key {
	return BlobStore.key("artifacts", artifactId, "images");
}

/** The ids `bytes`, an image for `document`, are addressed by: its own, and the SHA-256 of the bytes. */
function imageIdsOf(document: ArtifactRow, bytes: Uint8Array): ArtifactImageIds {
	const imageId = createHash("sha256").update(bytes).digest("hex");
	const ids = artifactImageIds({ podId: document.podId, artifactId: document.id, imageId });
	if (!ids)
		throw new Error(`Artifact ${document.id} in pod ${document.podId} has ids no address holds`);
	return ids;
}

const isTooLarge = (error: unknown): error is BlobStore.TooLarge =>
	error instanceof BlobStore.TooLarge;

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

/**
 * The change wrote no version: somebody asked for it from inside the
 * document, so it waits there as one suggestion, its words and how a deck
 * looks alike, which takes effect if one of the people in it accepts it. A
 * box it moves in front of or behind another was moved at once.
 */
export class Suggested extends Data.TaggedError("ArtifactChangeSuggested") {}

/**
 * The change couldn't be made as asked, and none of it was made: it was to
 * be a suggestion, and what it changes can't carry a suggestion's marks, as a
 * code block can't.
 */
export class SuggestionBlocked extends Data.TaggedError("ArtifactSuggestionBlocked") {}

/**
 * The live document holds content this version of the app cannot read, as a
 * newer version's would be, or a deck holds what no deck can: it can't be
 * read whole, and changing it here would lose that content.
 */
export class Unreadable extends Data.TaggedError("ArtifactUnreadable") {}

/**
 * The HTML an agent wrote for a deck can't be the deck, so nothing was
 * changed: it holds no slide and nothing a slide could (`saysNothing`), or
 * it can't be read whole (see `DeckUnreadable`).
 */
export class DeckHtmlRefused extends Data.TaggedError("ArtifactDeckHtmlRefused")<{
	readonly reason: TextRefused;
}> {}

/**
 * The change asks for nothing the artifact, of `kind`, keeps, so it was left
 * as it was and no version was written: it says what the artifact says
 * already, or, for a deck, adds only what a deck doesn't keep, as a CSS
 * property it has no place for.
 */
export class Unchanged extends Data.TaggedError("ArtifactUnchanged")<{
	readonly kind: ArtifactKind;
}> {}

/**
 * Why a change wrote no version. `Suggested` wrote its suggestion into the
 * live document, and moved any box it moves among a slide's others; the
 * others left the artifact as it was.
 */
export type NotWritten = Suggested | SuggestionBlocked | Unreadable | DeckHtmlRefused | Unchanged;

/** An image for a document is over `maxSize` bytes, the most kept. */
export class ImageTooLarge
	extends Data.TaggedError("ArtifactImageTooLarge")<{
		readonly maxSize: number;
	}>
	implements UserFacing
{
	get userMessage() {
		const { amount, unit } = sizeForPeople(this.maxSize);
		return userText`The image is larger than ${amount} ${unit}, the most a document keeps of one`;
	}
}

/** An image for a document said to be of `contentType` holds bytes of another kind, or of none. */
export class ImageNotOfType
	extends Data.TaggedError("ArtifactImageNotOfType")<{
		readonly contentType: ArtifactImageType;
	}>
	implements UserFacing
{
	get userMessage() {
		return userText`The file says it is a ${IMAGE_TYPE_NAMES[this.contentType]} image, but its content isn't one`;
	}
}

const IMAGE_TYPE_NAMES = {
	"image/png": "PNG",
	"image/jpeg": "JPEG",
	"image/gif": "GIF",
	"image/webp": "WebP",
} as const satisfies Record<ArtifactImageType, string>;

/** A document's images would come to more than `maxSize` bytes, the most it keeps of them in all. */
export class ImagesFull
	extends Data.TaggedError("ArtifactImagesFull")<{
		readonly maxSize: number;
	}>
	implements UserFacing
{
	get userMessage() {
		const { amount, unit } = sizeForPeople(this.maxSize);
		return userText`A document keeps ${amount} ${unit} of images at most, and this one would take it past that`;
	}
}

/** The document keeps no image under `imageId`. */
export class ImageNotFound
	extends Data.TaggedError("ArtifactImageNotFound")<{
		readonly imageId: string;
	}>
	implements UserFacing
{
	get userMessage() {
		return userText`That image isn't there`;
	}
}

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
