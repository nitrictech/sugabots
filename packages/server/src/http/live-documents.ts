import { artifactImageTypeSchema } from "@sugabots/contracts";
import { API_BASE_PATH, type ArtifactImageIds } from "@sugabots/contracts/http";
import { LIVE_DOCUMENT_SCHEMA } from "@sugabots/contracts/live-document";
import { Artifacts } from "@sugabots/core/artifacts/artifacts";
import { LiveDocuments } from "@sugabots/core/artifacts/live";
import { WORD_CONTENT_TYPE, wordFileOf } from "@sugabots/core/artifacts/word";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { Installation } from "@sugabots/core/installation/installation";
import { Data, Effect, Layer, Queue, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";
import { Authentication } from "../auth/authentication.ts";
import { storeOutagesAsDefects } from "./errors.ts";

/**
 * A `document` artifact as people work on it: the WebSocket the web app's
 * editor opens, which joins the person to the artifact's live document for as
 * long as it stays open, and the document as a Word file. Anyone who can read
 * the artifact can edit it and download it.
 */
export const liveDocumentRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const authentication = yield* Authentication.Service;
		const artifacts = yield* Artifacts.Service;
		const live = yield* LiveDocuments.Service;
		const trusted = new Set((yield* Installation.Service).trustedOrigins);

		/**
		 * An image the document keeps, for its Word file: `undefined` when it
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
		 * The document the request's path names, if whoever holds its session may
		 * read it, and how to act as them.
		 */
		const requestedDocument = Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const holder = yield* authentication.identify(new Headers(request.headers));
			if (!holder) return yield* new Refused({ status: 401 });
			const { podId, artifactId } = yield* HttpRouter.params;
			if (!podId || !artifactId) return yield* new Refused({ status: 404 });
			const asHolder = CurrentActor.provide(
				CurrentActor.AuthenticatedUserId.vouchedFor(holder.user.id),
			);
			const artifact = yield* artifacts.get({ podId, artifactId }).pipe(asHolder);
			if (artifact.kind !== "document") return yield* new Refused({ status: 404 });
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
				// An editor built for another schema would delete what it could not hold.
				if (schemaOf(request.url) !== LIVE_DOCUMENT_SCHEMA) {
					return HttpServerResponse.text("Reload to get the editor this document needs", {
						status: 409,
					});
				}
				const { artifact } = yield* requestedDocument;
				yield* edit(yield* request.upgrade, (outgoing) => live.join(artifact, outgoing));
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

		yield* router.add(
			"GET",
			`${API_BASE_PATH}/pods/:podId/artifacts/:artifactId/word`,
			Effect.gen(function* () {
				const { artifact, asHolder } = yield* requestedDocument;
				// What people have typed, where the document is live; its last version otherwise.
				const markdown = (yield* live.markdown(artifact.id)) ?? artifact.content;
				const file = yield* wordFileOf(artifact, markdown, (image) =>
					keptImage(image).pipe(asHolder),
				);
				return HttpServerResponse.uint8Array(file, { contentType: WORD_CONTENT_TYPE }).pipe(
					HttpServerResponse.setHeader(
						"content-disposition",
						`attachment; filename*=UTF-8''${encodeURIComponent(`${artifact.title}.docx`)}`,
					),
				);
			}).pipe(
				// Reading the images asks again whether the person may read the document, as they may have been taken out of its pod meanwhile.
				Effect.catchTags({ ...refusedAsStatus, ...storeOutagesAsDefects }),
				Effect.catchTag("DocumentRefused", refusal),
			),
		);
	}),
);

/** A refusal to read the document, as the status that says so: hidden as absent, so an id cannot be probed for. */
const refusedAsStatus = {
	ResourceHidden: () => Effect.fail(new Refused({ status: 404 })),
	ActionForbidden: () => Effect.fail(new Refused({ status: 403 })),
};

const isImageType = Schema.is(artifactImageTypeSchema);

/** The schema the editor asking to join says it was built for, from the address it asked at. */
const schemaOf = (url: string) =>
	Number(new URL(url, "http://live.invalid").searchParams.get("schema"));

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
