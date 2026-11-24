import {
	type Artifact,
	type ArtifactImageType,
	artifactImageTypeSchema,
	isEditedLive,
	LIVE_EDITOR_REFUSED_CLOSE_CODE,
	type LiveArtifactKind,
	liveEditorQuerySchema,
} from "@sugabots/contracts";
import { API_BASE_PATH, type ArtifactImageIds } from "@sugabots/contracts/http";
import { LIVE_DOCUMENT_SCHEMA } from "@sugabots/contracts/live-document";
import { Artifacts } from "@sugabots/core/artifacts/artifacts";
import { LiveDocuments } from "@sugabots/core/artifacts/live";
import { POWERPOINT_CONTENT_TYPE, powerPointFileOf } from "@sugabots/core/artifacts/powerpoint";
import { WORD_CONTENT_TYPE, wordFileOf } from "@sugabots/core/artifacts/word";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { Installation } from "@sugabots/core/installation/installation";
import { Data, Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";
import { Authentication } from "../auth/authentication.ts";
import { storeOutagesAsDefects } from "./errors.ts";

/**
 * A `document` or `slides` artifact as people work on it: the WebSocket the
 * web app's editor opens, which joins the person to the artifact's live
 * document for as long as it stays open if the editor was built for the
 * artifact's schema and kind, a document as a Word file, and a deck as a
 * PowerPoint file. Anyone who can read the artifact can edit it and download
 * it.
 */
export const liveDocumentRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const authentication = yield* Authentication.Service;
		const artifacts = yield* Artifacts.Service;
		const live = yield* LiveDocuments.Service;
		const trusted = new Set((yield* Installation.Service).trustedOrigins);

		/**
		 * An image the document or deck keeps, for its file: `undefined` when it
		 * keeps none under that id, or the one kept isn't of a kind a document
		 * keeps, which the file shows as its words.
		 */
		const keptImage = (image: ArtifactImageIds) =>
			artifacts.image(image).pipe(
				Effect.flatMap(({ contentType, stream }) =>
					isImageType(contentType)
						? Effect.map(Stream.runCollect(stream), (chunks) => ({
								contentType,
								bytes: Buffer.concat(chunks),
							}))
						: Effect.succeed(undefined),
				),
				Effect.catchTags({
					ArtifactImageNotFound: () => Effect.succeed(undefined),
					// Deleted while it was read, with the document.
					BlobNotFound: () => Effect.succeed(undefined),
				}),
			);

		/**
		 * The artifact the request's path names, if whoever holds its session may
		 * read it, and how to act as them.
		 */
		const requestedArtifact = Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const holder = yield* authentication.identify(new Headers(request.headers));
			if (!holder) return yield* new Refused({ status: 401 });
			const { podId, artifactId } = yield* HttpRouter.params;
			if (!podId || !artifactId) return yield* new Refused({ status: 404 });
			const asHolder = CurrentActor.provide(
				CurrentActor.AuthenticatedUserId.vouchedFor(holder.user.id),
			);
			const artifact = yield* artifacts.get({ podId, artifactId }).pipe(asHolder);
			return { artifact, asHolder };
		}).pipe(Effect.catchTags(refusedAsStatus));

		yield* router.add(
			"GET",
			`${API_BASE_PATH}/pods/:podId/artifacts/:artifactId/live`,
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				// Any page the browser visits can open a WebSocket here with the
				// person's cookie, so only the web app's own origin may.
				if (!request.headers.origin || !trusted.has(request.headers.origin)) {
					return HttpServerResponse.text("Untrusted origin", { status: 403 });
				}
				const { artifact } = yield* requestedArtifact;
				if (!isEditedLive(artifact)) return yield* new Refused({ status: 404 });
				const socket = yield* request.upgrade;
				// An editor built for another schema or another kind of artifact would delete what it could not hold.
				if (!isBuiltFor(request.url, artifact.kind)) {
					yield* refuseEditor(socket);
					return HttpServerResponse.empty();
				}
				yield* edit(socket, (outgoing) => live.join(artifact, outgoing));
				return HttpServerResponse.empty();
			}).pipe(
				Effect.catchTag("DocumentRefused", refusal),
				Effect.catchCause((cause) =>
					Effect.logWarning("A live document's connection ended badly", cause).pipe(
						Effect.as(HttpServerResponse.empty({ status: 502 })),
					),
				),
			),
		);

		for (const download of DOWNLOADS) {
			yield* router.add(
				"GET",
				`${API_BASE_PATH}/pods/:podId/artifacts/:artifactId/${download.path}`,
				Effect.gen(function* () {
					const { artifact, asHolder } = yield* requestedArtifact;
					if (artifact.kind !== download.kind) return yield* new Refused({ status: 404 });
					// What people have typed, where the artifact is live; its last version otherwise.
					const markdown = (yield* live.markdown(artifact.id)) ?? artifact.content;
					const file = yield* download.fileOf(artifact, markdown, (image) =>
						keptImage(image).pipe(asHolder),
					);
					return HttpServerResponse.uint8Array(file, { contentType: download.contentType }).pipe(
						HttpServerResponse.setHeader(
							"content-disposition",
							`attachment; filename*=UTF-8''${encodeURIComponent(`${artifact.title}.${download.extension}`)}`,
						),
					);
				}).pipe(
					// Reading the images asks again whether the person may read the artifact, as they may have been taken out of its pod meanwhile.
					Effect.catchTags({ ...refusedAsStatus, ...storeOutagesAsDefects }),
					Effect.catchTag("DocumentRefused", refusal),
				),
			);
		}
	}),
);

/** A file a live artifact of one kind downloads as, built from its markdown and the images it keeps. */
interface Download {
	/** The last part of its address, after the artifact's. */
	path: string;
	kind: LiveArtifactKind;
	contentType: string;
	extension: string;
	fileOf: <E, R>(
		artifact: Pick<Artifact, "podId" | "id" | "title">,
		markdown: string,
		imageOf: (
			image: ArtifactImageIds,
		) => Effect.Effect<{ contentType: ArtifactImageType; bytes: Uint8Array } | undefined, E, R>,
	) => Effect.Effect<Uint8Array, E, R>;
}

/** A document downloads as a Word file, and a deck as a PowerPoint file. */
const DOWNLOADS: readonly Download[] = [
	{
		path: "word",
		kind: "document",
		contentType: WORD_CONTENT_TYPE,
		extension: "docx",
		fileOf: wordFileOf,
	},
	{
		path: "powerpoint",
		kind: "slides",
		contentType: POWERPOINT_CONTENT_TYPE,
		extension: "pptx",
		fileOf: powerPointFileOf,
	},
];

/** A refusal to read the document, as the status that says so: hidden as absent, so an id cannot be probed for. */
const refusedAsStatus = {
	ResourceHidden: () => Effect.fail(new Refused({ status: 404 })),
	ActionForbidden: () => Effect.fail(new Refused({ status: 403 })),
};

const isImageType = Schema.is(artifactImageTypeSchema);

/**
 * Whether the editor asking to join says, in the address it asked at, that
 * it was built for the schema live documents are kept in and for `kind`.
 */
const isBuiltFor = (url: string, kind: LiveArtifactKind) =>
	Option.exists(
		decodeLiveEditorQuery(Object.fromEntries(new URL(url, "http://live.invalid").searchParams)),
		(builtFor) => builtFor.schema === LIVE_DOCUMENT_SCHEMA && builtFor.kind === kind,
	);

const decodeLiveEditorQuery = Schema.decodeUnknownOption(liveEditorQuerySchema);

/**
 * Closes the socket of an editor that must not join with the code that tells
 * it to stop and be reloaded, which a browser can read, where it can't read
 * why an upgrade was refused and would try again for ever.
 */
const refuseEditor = (socket: Socket.Socket) =>
	Effect.scoped(
		Effect.gen(function* () {
			// Reading opens the socket, which nothing can be written to before.
			yield* socket.reader;
			const writer = yield* socket.writer;
			yield* writer.write(
				new Socket.CloseEvent(
					LIVE_EDITOR_REFUSED_CLOSE_CODE,
					"Reload to get the editor this artifact needs",
				),
			);
		}),
	).pipe(Effect.ignore);

/** Why a request for a document gets no document, as the status that says so. */
class Refused extends Data.TaggedError("DocumentRefused")<{
	readonly status: 401 | 403 | 404;
}> {}

const refusal = ({ status }: Refused) => Effect.succeed(HttpServerResponse.empty({ status }));

/**
 * Passes frames between the person's socket and the live document they
 * `join`, until the socket closes. What the document sends is queued, because
 * it sends from callbacks and the frames must leave in the order it sent them.
 */
function edit(
	socket: Socket.Socket,
	join: (outgoing: LiveDocuments.Outgoing) => Effect.Effect<LiveDocuments.Participant>,
) {
	return Effect.scoped(
		Effect.gen(function* () {
			const reader = yield* socket.reader;
			const writer = yield* socket.writer;
			const toPerson = yield* Queue.unbounded<Uint8Array | Socket.CloseEvent>();
			const participant = yield* Effect.acquireRelease(
				join({
					send: (bytes) => void Queue.offerUnsafe(toPerson, bytes),
					close: () => void Queue.offerUnsafe(toPerson, new Socket.CloseEvent()),
				}),
				(joined) => Effect.sync(joined.leave),
			);
			const send = Queue.take(toPerson).pipe(Effect.flatMap(writer.write), Effect.forever);
			const receive = reader.pull.pipe(
				Effect.tap((frames) =>
					Effect.sync(() => {
						for (const frame of frames) {
							if (typeof frame !== "string") participant.receive(frame);
						}
					}),
				),
				Effect.forever,
			);
			return yield* Effect.raceFirst(send, receive);
		}),
	).pipe(Effect.ignore);
}
