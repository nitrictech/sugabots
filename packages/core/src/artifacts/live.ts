export * as LiveDocuments from "./live.ts";

import { type Document, Hocuspocus } from "@hocuspocus/server";
import type { AgentColor, AgentFace, AgentShape, Artifact } from "@sugabots/contracts";
import {
	type EditRequest,
	LIVE_DOCUMENT_CONTENT,
	LIVE_DOCUMENT_EDIT_REQUESTS,
	suggestionId,
	suggestionsAsAttributes,
	suggestionsFromAttributes,
} from "@sugabots/contracts/live-document";
import {
	liveDocumentFromMarkdown,
	liveDocumentSchema,
	markdownOfLiveDocument,
} from "@sugabots/contracts/live-document-markdown";
import type { Node } from "@tiptap/pm/model";
import {
	prosemirrorToYXmlFragment,
	updateYFragment,
	yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import { Context, Effect, Layer, Stream } from "effect";
import { applyUpdate, Doc, encodeStateAsUpdate, XmlElement, type XmlFragment, XmlText } from "yjs";
import { BlobStore } from "../blob-store/blob-store.ts";
import { Ids } from "../ids/ids.ts";
import { type Blocked, changedTo, withoutSuggestions } from "./suggestions.ts";

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
	/**
	 * The live document as markdown, without the suggestions pending in it, or
	 * `undefined` if the artifact has never been opened live.
	 */
	readonly markdown: (artifactId: string) => Effect.Effect<string | undefined>;
	/**
	 * Changes the live document to the markdown `change` returns for what it
	 * holds now, showing `author` to the people in it. Only the parts that
	 * differ are written, so what people are typing elsewhere is kept. A
	 * `change` returning `undefined` changes nothing. `undefined` if the
	 * artifact has never been opened live.
	 *
	 * A change the agent makes in a thread somebody started by asking for an
	 * edit from inside the document is not made: it is shown to the people in
	 * the document as a suggestion, and the document reads as before until one
	 * of them accepts it.
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
	const ids = yield* Ids.Service;

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
							prosemirrorToYXmlFragment(
								liveDocumentFromMarkdown(context.startFrom),
								fragmentOf(document),
							);
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
			Effect.gen(function* () {
				if (!(yield* isLive(artifactId))) return undefined;
				const unique = yield* ids.next;
				const rewritten = yield* withDocument(artifactId, (document): Rewritten => {
					const { content, unreadable } = read(document);
					const markdown = asMarkdown(content);
					const wanted = change(markdown);
					if (wanted === undefined) return { markdown, outcome: "unchanged" };
					// Writing what could be read back would write over what could not.
					if (unreadable) return { markdown, outcome: "blocked", blocked: "unreadable" };
					const requests = document.getMap<EditRequest>(LIVE_DOCUMENT_EDIT_REQUESTS);
					const request = requests.get(author.threadId);
					const after = changedTo(
						content,
						liveDocumentFromMarkdown(wanted),
						request
							? { suggestionId: suggestionId(unique, { kind: "agent", name: author.name }) }
							: "edit",
					);
					if (after === "unchanged") return { markdown, outcome: "unchanged" };
					if (typeof after === "string") return { markdown, outcome: "blocked", blocked: after };
					document.awareness.setLocalState({
						user: { name: author.name, color: AGENT_COLOR, agent: author.look },
					});
					updateYFragment(document, fragmentOf(document), suggestionsAsAttributes(after), {
						mapping: new Map(),
						isOMark: new Map(),
					});
					if (request) requests.set(author.threadId, { ...request, answered: true });
					return { markdown: toMarkdown(document), outcome: request ? "suggested" : "written" };
				});
				if (rewritten.outcome === "written" || rewritten.outcome === "suggested") {
					yield* Effect.forkDetach(hideAuthorLater(artifactId));
				}
				return rewritten;
			}),
	});
});

/** Needs the blob store and ids, which the entry point provides. */
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

/**
 * The agent a change is shown as coming from: its name, its face to draw
 * beside the people's, and the thread it is working in, which decides
 * whether its change is made or suggested.
 */
export interface Author {
	readonly name: string;
	readonly threadId: string;
	readonly look: {
		readonly color: AgentColor;
		readonly face: AgentFace;
		readonly shape: AgentShape;
	};
}

/**
 * What `rewrite` did, and the live document's markdown after it: `written`
 * into the document, `suggested` to the people in it, `unchanged` because the
 * change asked for nothing, or `blocked`: it was to be a suggestion and
 * couldn't be shown as one, or the document holds content this version of the
 * app cannot read (`unreadable`), which a write would lose.
 */
export type Rewritten =
	| { readonly markdown: string; readonly outcome: "written" | "suggested" | "unchanged" }
	| {
			readonly markdown: string;
			readonly outcome: "blocked";
			readonly blocked: Blocked | "unreadable";
	  };

interface ConnectionContext {
	artifactId: string;
	/** The markdown a document nobody has opened before starts from. */
	startFrom?: string;
}

const fragmentOf = (document: Document) => document.getXmlFragment(LIVE_DOCUMENT_CONTENT);

/**
 * The document's content, with what is suggested for whole blocks marked on
 * them as the document carries it, and whether all of it could be read.
 *
 * Reading shared content deletes whatever this schema cannot hold, such as a
 * block written by a newer version of the app. So it is read from a copy,
 * which is thrown away, and the document itself keeps everything.
 */
function read(document: Document): { content: Node; unreadable: boolean } {
	const copy = new Doc();
	applyUpdate(copy, encodeStateAsUpdate(document));
	const shared = copy.getXmlFragment(LIVE_DOCUMENT_CONTENT);
	const before = sizeOf(shared);
	const content = suggestionsFromAttributes(
		yXmlFragmentToProseMirrorRootNode(shared, liveDocumentSchema),
	);
	const after = sizeOf(shared);
	return { content, unreadable: after.blocks !== before.blocks || after.text !== before.text };
}

/** How many blocks and how much text shared content holds, which reading it must not change. */
function sizeOf(shared: XmlFragment | XmlElement): { blocks: number; text: number } {
	let [blocks, text] = [0, 0];
	for (const child of shared.toArray()) {
		if (child instanceof XmlText) text += child.length;
		if (!(child instanceof XmlElement)) continue;
		const within = sizeOf(child);
		blocks += 1 + within.blocks;
		text += within.text;
	}
	return { blocks, text };
}

/** Content as it reads until someone accepts a suggestion pending in it. */
const asMarkdown = (content: Node) => markdownOfLiveDocument(withoutSuggestions(content));

/** The document as it reads until someone accepts a suggestion pending in it, as far as it can be read. */
const toMarkdown = (document: Document) => asMarkdown(read(document).content);

/** Beside the artifact's versions, so it is deleted with them. */
const stateKey = (artifactId: string) => BlobStore.key("artifacts", artifactId, "live");

/** The caret colour agents are shown with. */
const AGENT_COLOR = "#0d9488";

/** How long people see an agent's name in the document after it writes. */
const AGENT_SHOWN_FOR = "6 seconds";

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
