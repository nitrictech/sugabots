export * as LiveDocuments from "./live.ts";

import { type Document, Hocuspocus } from "@hocuspocus/server";
import {
	type AgentColor,
	type AgentFace,
	type AgentShape,
	type Artifact,
	isEditedLive,
	type LiveArtifactKind,
} from "@sugabots/contracts";
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
} from "@sugabots/contracts/live-document-markdown";
import type { Node } from "@tiptap/pm/model";
import {
	prosemirrorToYXmlFragment,
	updateYFragment,
	yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Stream } from "effect";
import { applyUpdate, Doc, encodeStateAsUpdate, XmlElement, type XmlFragment, XmlText } from "yjs";
import { BlobStore } from "../blob-store/blob-store.ts";
import { Database, query } from "../database/database.ts";
import { artifact } from "../database/schema.ts";
import { Ids } from "../ids/ids.ts";
import { type Blocked, changedTo, markdownForAgents, withoutSuggestions } from "./suggestions.ts";

/**
 * A `document` or `slides` artifact while it is being edited: one copy held
 * in this process that every writer changes at once. People reach it over a
 * socket from the editor, and an agent's tools change it here, so neither
 * waits for the other and both see each other's work as it lands.
 *
 * What the copy holds, and how it is read and written as markdown, is the
 * artifact's kind's. Every operation reads the kind from the artifact's row,
 * which the editor's kind comes from too: content written as another kind
 * would be deleted by every editor, whose schema can't hold it.
 *
 * A document becomes live the first time a person opens it, and stays live:
 * its state is kept in the blob store beside its versions. Its versions are
 * then snapshots of `markdownForAgents`, which says nothing of where people
 * placed a deck's boxes or which boxes they removed; `documentAsShown` says
 * both, and is never for an agent.
 */
export interface Interface {
	/**
	 * Joins a person to the live document of `artifact`, which starts from
	 * `artifact.content` if nobody has opened it before. Only a caller that
	 * knows the person may read the artifact joins them. What the document
	 * sends them goes to `outgoing`, and what they send goes to the
	 * participant returned. Dies if the artifact is gone or isn't of a kind
	 * people edit live.
	 */
	readonly join: (
		artifact: Pick<Artifact, "id" | "content">,
		outgoing: Outgoing,
	) => Effect.Effect<Participant>;
	/**
	 * The live document of the artifact `artifactId` as an agent reads it: as
	 * markdown, without the suggestions pending in it, which says nothing of
	 * where people placed a deck's boxes or which boxes they removed.
	 * `undefined` if it has none: it has never been opened live, or it isn't
	 * of a kind people edit live.
	 */
	readonly markdownForAgents: (artifactId: string) => Effect.Effect<string | undefined>;
	/**
	 * The live document of the artifact `artifactId` as people see it until
	 * somebody accepts a suggestion pending in it: with a deck's boxes where
	 * people placed them, and those they removed off their slides, as a file
	 * the deck is saved as draws them. Never for an agent, which may neither
	 * read nor set either (see `markdownForAgents`). `undefined` when it has
	 * none, as for `markdownForAgents`.
	 */
	readonly documentAsShown: (artifactId: string) => Effect.Effect<Node | undefined>;
	/**
	 * Changes the live document of the artifact `artifactId` as `change` asks,
	 * showing `author` to the people in it: `change` is given the document as
	 * `markdownForAgents` gives it, and returns that markdown changed. Only
	 * what it changed is written. Every block it left as it was stays as the
	 * document holds it, even where markdown can't say all of that, and what
	 * people are typing elsewhere is kept. A `change` returning `undefined`
	 * changes nothing. `undefined` if the artifact has no live document, as
	 * for `markdownForAgents`.
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
	const database = yield* Database;
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

	const store = (artifactId: string, document: Document) =>
		blobs
			.put(stateKey(artifactId), {
				stream: Stream.succeed(encodeStateAsUpdate(document)),
				contentType: "application/octet-stream",
			})
			.pipe(Effect.orDie);

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
							const { kind, markdown } = context.startFrom;
							prosemirrorToYXmlFragment(
								liveDocumentFromMarkdown(kind, markdown),
								fragmentOf(document),
							);
							// A build from markdown is new content each time, which an editor
							// still holding an earlier build would merge in beside it, doubling
							// every block. So it is stored before anyone is given it, or the load
							// fails: otherwise it is stored only once someone changes it, and an
							// unchanged document leaves memory when its last person leaves.
							await Effect.runPromise(store(documentName, document));
						}
					},
					onStoreDocument: async ({ documentName, document }) => {
						await Effect.runPromise(store(documentName, document));
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

	/** The kind of the artifact `artifactId`, from its row, when it is one people edit live. */
	const liveKindOf = (artifactId: string) =>
		query((db) =>
			db.select({ kind: artifact.kind }).from(artifact).where(eq(artifact.id, artifactId)),
		).pipe(
			Effect.map(([row]) => (row && isEditedLive(row) ? row.kind : undefined)),
			Effect.provideService(Database, database),
		);

	/**
	 * The kind of the artifact's live document, as its row says, or `undefined`
	 * when it has none: nobody has opened it live, or it isn't of a kind people
	 * edit live.
	 */
	const openedKindOf = (artifactId: string) =>
		Effect.gen(function* () {
			const kind = yield* liveKindOf(artifactId);
			if (kind === undefined || !(yield* isLive(artifactId))) return undefined;
			return kind;
		});

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
		join: ({ id: artifactId, content }, outgoing) =>
			Effect.gen(function* () {
				const kind = yield* liveKindOf(artifactId);
				if (kind === undefined) {
					return yield* Effect.die(new Error(`Artifact ${artifactId} has no live document`));
				}
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
					new Request(`http://live.invalid/${artifactId}`),
					{ artifactId, startFrom: { kind, markdown: content } },
				);
				return {
					receive: (bytes: Uint8Array) => connection.handleMessage(bytes),
					leave: () => {
						open = false;
						connection.handleClose();
					},
				};
			}),

		markdownForAgents: (artifactId) =>
			Effect.gen(function* () {
				const kind = yield* openedKindOf(artifactId);
				if (kind === undefined) return undefined;
				return yield* withDocument(artifactId, (document) => markdownForAgentsIn(document, kind));
			}),

		documentAsShown: (artifactId) =>
			Effect.gen(function* () {
				const kind = yield* openedKindOf(artifactId);
				if (kind === undefined) return undefined;
				return yield* withDocument(artifactId, (document) =>
					withoutSuggestions(read(document, kind).content),
				);
			}),

		rewrite: (artifactId, author, change) =>
			Effect.gen(function* () {
				const kind = yield* openedKindOf(artifactId);
				if (kind === undefined) return undefined;
				const unique = yield* ids.next;
				const rewritten = yield* withDocument(artifactId, (document): Rewritten => {
					const { content, unreadable } = read(document, kind);
					const markdown = markdownForAgents(content);
					const wanted = change(markdown);
					if (wanted === undefined) return { markdown, outcome: "unchanged" };
					// Writing what could be read back would write over what could not.
					if (unreadable) return { markdown, outcome: "blocked", blocked: "unreadable" };
					const requests = document.getMap<EditRequest>(LIVE_DOCUMENT_EDIT_REQUESTS);
					const request = requests.get(author.threadId);
					const after = changedTo(
						content,
						wanted,
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
					return {
						markdown: markdownForAgentsIn(document, kind),
						outcome: request ? "suggested" : "written",
					};
				});
				if (rewritten.outcome === "written" || rewritten.outcome === "suggested") {
					yield* Effect.forkDetach(hideAuthorLater(artifactId));
				}
				return rewritten;
			}),
	});
});

/** Needs the database, the blob store and ids, which the entry point provides. */
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
 * change asked for nothing, or `blocked`, none of it made: it couldn't be
 * made as asked for a suggestion's sake (see `Blocked`), or the document
 * holds content this version of the app cannot read (`unreadable`), which a
 * write would lose.
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
	/** The markdown a document nobody has opened before starts from, and the kind it is written as. */
	startFrom?: { kind: LiveArtifactKind; markdown: string };
}

const fragmentOf = (document: Document) => document.getXmlFragment(LIVE_DOCUMENT_CONTENT);

/**
 * The content of a document of `kind`, with what is suggested for whole
 * blocks marked on them as the document carries it, and whether all of it
 * could be read.
 *
 * Reading shared content deletes whatever this schema cannot hold, such as a
 * block written by a newer version of the app, or all of it when read as
 * another kind. So it is read from a copy, which is thrown away, and the
 * document itself keeps everything.
 */
function read(document: Document, kind: LiveArtifactKind): { content: Node; unreadable: boolean } {
	const copy = new Doc();
	applyUpdate(copy, encodeStateAsUpdate(document));
	const shared = copy.getXmlFragment(LIVE_DOCUMENT_CONTENT);
	const before = sizeOf(shared);
	const content = suggestionsFromAttributes(
		yXmlFragmentToProseMirrorRootNode(shared, liveDocumentSchema(kind)),
	);
	const after = sizeOf(shared);
	const lost = after.blocks !== before.blocks || after.text !== before.text;
	return { content, unreadable: lost || !fitsSchema(content) };
}

/**
 * Whether content read from a live document is what its schema allows.
 * Reading deletes a block that doesn't fit where it stands, but takes the
 * blocks at the top as they come: a document's paragraphs read as a deck
 * come out whole, where only slides belong, and would be written back as
 * slides.
 */
function fitsSchema(content: Node): boolean {
	try {
		content.check();
		return true;
	} catch {
		return false;
	}
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

/** `document`, of `kind`, as an agent reads it (`markdownForAgents`), as far as it can be read. */
const markdownForAgentsIn = (document: Document, kind: LiveArtifactKind) =>
	markdownForAgents(read(document, kind).content);

/** Beside the artifact's versions, so it is deleted with them. */
const stateKey = (artifactId: string) => BlobStore.key("artifacts", artifactId, "live");

/** The caret colour agents are shown with. */
const AGENT_COLOR = "#0d9488";

/** How long people see an agent's name in the document after it writes. */
const AGENT_SHOWN_FOR = "6 seconds";

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
