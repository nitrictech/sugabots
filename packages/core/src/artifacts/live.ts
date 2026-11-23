export * as LiveDocuments from "./live.ts";

import { type Document, Hocuspocus } from "@hocuspocus/server";
import type { AgentColor, AgentFace, AgentShape, Artifact } from "@sugabots/contracts";
import { getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Node } from "@tiptap/pm/model";
import { StarterKit } from "@tiptap/starter-kit";
import {
	prosemirrorToYXmlFragment,
	updateYFragment,
	yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import { Context, Effect, Layer, Stream } from "effect";
import { applyUpdate, encodeStateAsUpdate } from "yjs";
import { BlobStore } from "../blob-store/blob-store.ts";

/**
 * A `document` artifact while it is being edited: one copy held in this
 * process that every writer changes at once. People reach it over a socket
 * from the editor, and an agent's tools change it here, so neither waits for
 * the other and both see each other's work as it lands.
 *
 * A document becomes live the first time a person opens it, and stays live:
 * its state is kept in the blob store beside its versions, and from then on
 * the versions are snapshots of it.
 */
export interface Interface {
	/**
	 * Joins a person to `artifact`'s live document, which starts from the
	 * artifact's content if nobody has opened it before. Holding the artifact
	 * shows the person may read it. What the document sends them goes to
	 * `outgoing`, and what they send goes to the participant returned.
	 */
	readonly join: (artifact: Artifact, outgoing: Outgoing) => Effect.Effect<Participant>;
	/** The live document as markdown, or `undefined` if the artifact has never been opened live. */
	readonly markdown: (artifactId: string) => Effect.Effect<string | undefined>;
	/**
	 * Changes the live document to the markdown `change` returns for what it
	 * holds now, showing `author` to the people in it. Only the parts that
	 * differ are written, so what people are typing elsewhere is kept. A
	 * `change` returning `undefined` changes nothing. `undefined` if the
	 * artifact has never been opened live.
	 */
	readonly rewrite: (
		artifactId: string,
		author: Author,
		change: (markdown: string) => string | undefined,
	) => Effect.Effect<Rewritten | undefined>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/Artifacts/LiveDocuments",
) {}

export const make = Effect.gen(function* () {
	const blobs = yield* BlobStore.Service;

	const stored = (artifactId: string) =>
		blobs.get(stateKey(artifactId)).pipe(
			Effect.flatMap((blob) => Stream.runCollect(blob.stream)),
			Effect.map((chunks) => Buffer.concat(chunks)),
			Effect.catchTag("BlobNotFound", () => Effect.succeed(undefined)),
			// A store that can't be reached is an infrastructure fault, as it is for an artifact's versions.
			Effect.orDie,
		);

	const hocuspocus = yield* Effect.acquireRelease(
		Effect.sync(
			() =>
				new Hocuspocus<ConnectionContext>({
					quiet: true,
					// One socket carries one artifact: the one its route let the person read.
					onConnect: async ({ documentName, context }) => {
						if (documentName !== context.artifactId) throw new Error("Not this socket's document");
					},
					onLoadDocument: async ({ documentName, document, context }) => {
						const state = await Effect.runPromise(stored(documentName));
						if (state) applyUpdate(document, state);
						else if (context.startFrom !== undefined) {
							prosemirrorToYXmlFragment(fromMarkdown(context.startFrom), fragmentOf(document));
						}
					},
					onStoreDocument: async ({ documentName, document }) => {
						await Effect.runPromise(
							blobs
								.put(stateKey(documentName), {
									stream: Stream.succeed(encodeStateAsUpdate(document)),
									contentType: "application/octet-stream",
								})
								.pipe(Effect.orDie),
						);
					},
				}),
		),
		(instance) =>
			Effect.promise(async () => {
				instance.closeConnections();
				instance.flushPendingStores();
			}),
	);

	const isLive = (artifactId: string) =>
		hocuspocus.documents.has(artifactId)
			? Effect.succeed(true)
			: Effect.map(stored(artifactId), (state) => state !== undefined);

	/** Runs `use` on the artifact's live document, loading it if it isn't open. */
	const withDocument = <A>(artifactId: string, use: (document: Document) => A) =>
		Effect.acquireUseRelease(
			Effect.promise(() => hocuspocus.openDirectConnection(artifactId, { artifactId })),
			(connection) =>
				Effect.promise(async () => {
					let result: { value: A } | undefined;
					await connection.transact((document) => {
						result = { value: use(document) };
					});
					if (!result) throw new Error("The live document's transaction did not run");
					return result.value;
				}),
			(connection) => Effect.promise(() => connection.disconnect()),
		);

	/** An agent is in the document only while it writes, so its name goes soon after. */
	const hideAuthorLater = (artifactId: string) =>
		Effect.sleep(AGENT_SHOWN_FOR).pipe(
			Effect.andThen(
				Effect.sync(() => hocuspocus.documents.get(artifactId)?.awareness.setLocalState(null)),
			),
		);

	return Service.of({
		join: (artifact, outgoing) =>
			Effect.sync(() => {
				let open = true;
				const connection = hocuspocus.handleConnection(
					{
						send: (data) => {
							if (!(data instanceof Uint8Array)) throw new Error("Live documents send bytes only");
							outgoing.send(data);
						},
						close: () => {
							open = false;
							outgoing.close();
						},
						get readyState() {
							return open ? SOCKET_OPEN : SOCKET_CLOSED;
						},
					},
					new Request(`http://live.invalid/${artifact.id}`),
					{ artifactId: artifact.id, startFrom: artifact.content },
				);
				return {
					receive: (bytes) => connection.handleMessage(bytes),
					leave: () => {
						open = false;
						connection.handleClose();
					},
				};
			}),

		markdown: (artifactId) =>
			Effect.flatMap(isLive(artifactId), (live) =>
				live ? withDocument(artifactId, toMarkdown) : Effect.succeed(undefined),
			),

		rewrite: (artifactId, author, change) =>
			Effect.flatMap(isLive(artifactId), (live) =>
				live
					? withDocument(artifactId, (document): Rewritten => {
							const before = toMarkdown(document);
							const after = change(before);
							if (after === undefined) return { markdown: before, changed: false };
							document.awareness.setLocalState({
								user: { name: author.name, color: AGENT_COLOR, agent: author.look },
							});
							updateYFragment(document, fragmentOf(document), fromMarkdown(after), {
								mapping: new Map(),
								isOMark: new Map(),
							});
							return { markdown: toMarkdown(document), changed: true };
						}).pipe(Effect.tap(() => Effect.forkDetach(hideAuthorLater(artifactId))))
					: Effect.succeed(undefined),
			),
	});
});

/** Needs the blob store, which the entry point provides. */
export const layer = Layer.effect(Service, make);

/** Where a live document's bytes for a person go. */
export interface Outgoing {
	readonly send: (bytes: Uint8Array) => void;
	readonly close: () => void;
}

/** A person in a live document, for as long as their socket is open. */
export interface Participant {
	/** Takes what the person's editor sent. */
	readonly receive: (bytes: Uint8Array) => void;
	/** Takes them out of the document, as when their socket closes. */
	readonly leave: () => void;
}

/** The agent a change is shown as coming from: its name, and its face to draw beside the people's. */
export interface Author {
	readonly name: string;
	readonly look: {
		readonly color: AgentColor;
		readonly face: AgentFace;
		readonly shape: AgentShape;
	};
}

/** The live document after `rewrite`, and whether `change` asked for anything. */
export interface Rewritten {
	readonly markdown: string;
	readonly changed: boolean;
}

interface ConnectionContext {
	artifactId: string;
	/** The markdown a document nobody has opened before starts from. */
	startFrom?: string;
}

/**
 * What a live document may hold. The editor in the web app builds its schema
 * from the same extensions (`screens/LiveDocument.tsx`): a node one side has
 * and the other lacks is dropped when it syncs.
 */
const extensions = [StarterKit];
const schema = getSchema(extensions);
const markdownOf = new MarkdownManager({ extensions });

/** The shared type the editor's collaboration extension binds to by default. */
const FRAGMENT = "default";

const fragmentOf = (document: Document) => document.getXmlFragment(FRAGMENT);

const toMarkdown = (document: Document) =>
	markdownOf.serialize(yXmlFragmentToProseMirrorRootNode(fragmentOf(document), schema).toJSON());

const fromMarkdown = (markdown: string) => Node.fromJSON(schema, markdownOf.parse(markdown));

/** Beside the artifact's versions, so it is deleted with them. */
const stateKey = (artifactId: string) => BlobStore.key("artifacts", artifactId, "live");

/** The caret colour agents are shown with. */
const AGENT_COLOR = "#0d9488";

/** How long people see an agent's name in the document after it writes. */
const AGENT_SHOWN_FOR = "6 seconds";

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
