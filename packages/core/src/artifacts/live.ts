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
import { type DeckUnreadable, UnreadableDeckHtml } from "@sugabots/contracts/deck-html";
import {
	type EditRequest,
	LIVE_DOCUMENT_CONTENT,
	LIVE_DOCUMENT_EDIT_REQUESTS,
	suggestionId,
	suggestionsAsAttributes,
	suggestionsFromAttributes,
} from "@sugabots/contracts/live-document";
import { liveDocumentFromText, liveDocumentSchema } from "@sugabots/contracts/live-document-text";
import type { Node } from "@tiptap/pm/model";
import {
	prosemirrorToYXmlFragment,
	updateYFragment,
	yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import { eq } from "drizzle-orm";
import { Context, Data, Effect, Layer, Stream } from "effect";
import { applyUpdate, Doc, encodeStateAsUpdate, XmlElement, type XmlFragment, XmlText } from "yjs";
import { BlobStore } from "../blob-store/blob-store.ts";
import { Database, query } from "../database/database.ts";
import { artifact } from "../database/schema.ts";
import { Ids } from "../ids/ids.ts";
import { readHtml } from "./html-reader.ts";
import {
	type Blocked,
	changedTo,
	type TextRefused,
	textForAgents,
	withoutSuggestions,
} from "./suggestions.ts";

/**
 * A `document` or `slides` artifact while it is being edited: one copy held
 * in this process that every writer changes at once. People reach it over a
 * socket from the editor, and an agent's tools change it here, so neither
 * waits for the other and both see each other's work as it lands.
 *
 * What the copy holds, and how it is read and written as text, is the
 * artifact's kind's: a document's markdown, or a deck's HTML. Every
 * operation reads the kind from the artifact's row, which the editor's kind
 * comes from too: content written as another kind would be deleted by every
 * editor, whose schema can't hold it.
 *
 * A document becomes live the first time a person opens it, and stays live:
 * its state is kept in the blob store beside its versions, and each version
 * an agent's change writes after that is `textForAgents` as the change left
 * it (see `artifacts.ts`).
 */
export interface Interface {
	/**
	 * Joins a person to the live document of `artifact`, which starts from
	 * `artifact.content`, its last version, if nobody has opened it before.
	 * Only a caller that knows the person may read the artifact joins them.
	 * What the document sends them goes to `outgoing`, and what they send goes
	 * to the participant returned. Fails with `Unreadable` when it starts from
	 * a deck's HTML that can't be read whole. Dies if the artifact is gone or
	 * isn't of a kind people edit live.
	 */
	readonly join: (
		artifact: Pick<Artifact, "id" | "content">,
		outgoing: Outgoing,
	) => Effect.Effect<Participant, Unreadable>;
	/**
	 * The live document of the artifact `artifactId` as an agent reads it: as
	 * its text, a document's markdown or a deck's HTML, without the
	 * suggestions pending in it. `undefined` if it has none: it has never been
	 * opened live, or it isn't of a kind people edit live. Fails with
	 * `Unreadable` for a live deck holding what no deck can, which can't be
	 * written as a deck's HTML.
	 */
	readonly textForAgents: (artifactId: string) => Effect.Effect<string | undefined, Unreadable>;
	/**
	 * The artifact's live document as people see it until somebody accepts a
	 * suggestion pending in it, as a file it is saved as draws it; or, when
	 * nobody has opened it, the document `artifact.content`, its last version,
	 * opens as. Fails with `Unreadable` for a deck that is neither: a live one
	 * holding what no deck can, or a last version whose HTML can't be read
	 * whole. Dies if the artifact is gone or isn't of a kind people edit live.
	 */
	readonly documentAsShown: (
		artifact: Pick<Artifact, "id" | "content">,
	) => Effect.Effect<Node, Unreadable>;
	/**
	 * Changes the live document of the artifact `artifactId` as `change` asks,
	 * showing `author` to the people in it: `change` is given the document as
	 * `textForAgents` gives it, and returns that text changed. Only what it
	 * changed is written. Every block it left as it was stays as the document
	 * holds it, even where its text can't say all of that, and what people are
	 * typing elsewhere is kept. A `change` returning `undefined` changes
	 * nothing, and one returning a deck's HTML that says nothing or can't be
	 * read whole is refused (see `TextRefused`). `undefined` if the artifact
	 * has no live document, as for `textForAgents`.
	 *
	 * A change the agent makes in a thread somebody started by asking for an
	 * edit from inside the document is shown to the people in it as a
	 * suggestion, the document reading as before until one of them accepts
	 * it; but what it changes in how a deck looks is made at once, as in any
	 * agent's change (see `changedTo`).
	 */
	readonly rewrite: (
		artifactId: string,
		author: Author,
		change: (text: string) => string | undefined,
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
							prosemirrorToYXmlFragment(context.startFrom, fragmentOf(document));
							// A build from text is new content each time, which an editor
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

	/** The kind of the artifact `artifactId`, from its row: dies if it is gone or isn't of a kind people edit live. */
	const kindOfLive = (artifactId: string) =>
		Effect.flatMap(liveKindOf(artifactId), (kind) =>
			kind === undefined
				? Effect.die(new Error(`Artifact ${artifactId} has no live document`))
				: Effect.succeed(kind),
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
				const kind = yield* kindOfLive(artifactId);
				// Read here, rather than as the document loads, so that a last version that can't be read is refused to the caller.
				const startFrom = (yield* isLive(artifactId)) ? undefined : yield* opened(kind, content);
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
					{ artifactId, startFrom },
				);
				return {
					receive: (bytes: Uint8Array) => connection.handleMessage(bytes),
					leave: () => {
						open = false;
						connection.handleClose();
					},
				};
			}),

		textForAgents: (artifactId) =>
			Effect.gen(function* () {
				const kind = yield* openedKindOf(artifactId);
				if (kind === undefined) return undefined;
				const live = yield* withDocument(artifactId, (document) => read(document, kind));
				if (live.outcome === "notADeck") return yield* new Unreadable({ reason: "notADeck" });
				return textForAgents(live.content);
			}),

		documentAsShown: ({ id: artifactId, content: lastVersion }) =>
			Effect.gen(function* () {
				const kind = yield* kindOfLive(artifactId);
				if (!(yield* isLive(artifactId))) return yield* opened(kind, lastVersion);
				const live = yield* withDocument(artifactId, (document) => read(document, kind));
				if (live.outcome === "notADeck") return yield* new Unreadable({ reason: "notADeck" });
				return withoutSuggestions(live.content);
			}),

		rewrite: (artifactId, author, change) =>
			Effect.gen(function* () {
				const kind = yield* openedKindOf(artifactId);
				if (kind === undefined) return undefined;
				const unique = yield* ids.next;
				const rewritten = yield* withDocument(artifactId, (document): Rewritten => {
					const live = read(document, kind);
					if (live.outcome === "notADeck") return { outcome: "blocked", blocked: "unreadable" };
					const text = textForAgents(live.content);
					const wanted = change(text);
					if (wanted === undefined) return { text, outcome: "unchanged" };
					// Writing what could be read back would write over what could not.
					if (live.outcome === "partly") return { outcome: "blocked", blocked: "unreadable" };
					const { content } = live;
					const requests = document.getMap<EditRequest>(LIVE_DOCUMENT_EDIT_REQUESTS);
					const request = requests.get(author.threadId);
					const after = changedTo(
						content,
						wanted,
						request
							? { suggestionId: suggestionId(unique, { kind: "agent", name: author.name }) }
							: "edit",
					);
					if (after === "unchanged") return { text, outcome: "unchanged" };
					if (typeof after === "string") return { outcome: "blocked", blocked: after };
					document.awareness.setLocalState({
						user: { name: author.name, color: AGENT_COLOR, agent: author.look },
					});
					updateYFragment(document, fragmentOf(document), suggestionsAsAttributes(after.document), {
						mapping: new Map(),
						isOMark: new Map(),
					});
					if (request) requests.set(author.threadId, { ...request, answered: true });
					const written = read(document, kind);
					if (written.outcome === "notADeck") {
						throw new Error(`A rewrite left the live deck ${artifactId} holding what no deck can`);
					}
					return {
						text: textForAgents(written.content),
						outcome: after.suggested ? "suggested" : "written",
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
 * What `rewrite` did, with the live document's text after it, but when it was
 * `blocked`: `written` into the document; `suggested` to the people in it,
 * what it changed in how a deck looks written all the same; `unchanged`
 * because the change asked for nothing, or asked for only what the document
 * can't hold; or `blocked`, none of it made: it couldn't be made as asked for
 * a suggestion's sake (see `Blocked`), the text it wrote can't be what the
 * document reads as (see `TextRefused`), or the document holds content this
 * version of the app cannot read (`unreadable`), which a write would lose.
 */
export type Rewritten =
	| { readonly text: string; readonly outcome: "written" | "suggested" | "unchanged" }
	| { readonly outcome: "blocked"; readonly blocked: Blocked | TextRefused | "unreadable" };

/**
 * A deck that can't be read as one, so it can be neither opened nor written
 * as a file, nor read by an agent: its last version's HTML can't be read
 * whole (see `DeckUnreadable`), or its live copy holds what no deck can
 * (`notADeck`), as a document's blocks do.
 */
export class Unreadable extends Data.TaggedError("LiveDocumentUnreadable")<{
	readonly reason: DeckUnreadable | "notADeck";
}> {}

interface ConnectionContext {
	artifactId: string;
	/** What a document nobody has opened before starts from: its last version, read. */
	startFrom?: Node;
}

/**
 * `text`, an artifact's last version, as the live document it opens as (see
 * `liveDocumentFromText`): fails with `Unreadable` for a deck's HTML that
 * can't be read whole.
 */
const opened = (kind: LiveArtifactKind, text: string): Effect.Effect<Node, Unreadable> =>
	Effect.suspend(() => {
		try {
			return Effect.succeed(liveDocumentFromText(kind, text, readHtml));
		} catch (error) {
			if (!(error instanceof UnreadableDeckHtml)) throw error;
			return Effect.fail(new Unreadable({ reason: error.reason }));
		}
	});

const fragmentOf = (document: Document) => document.getXmlFragment(LIVE_DOCUMENT_CONTENT);

/**
 * What a live document's content reads as, told apart so that each caller
 * acts on each:
 *
 * - `whole`: all of it, as its kind's schema holds it.
 * - `partly`: what reading could make of it, which a write would lose the
 *   rest of: reading deleted what the schema can't hold, such as a block
 *   written by a newer version of the app, or what is left isn't what the
 *   schema allows, as a document holding no block. A document's markdown can
 *   still be written from it.
 * - `notADeck`: a deck's content that isn't what a deck's schema allows, as
 *   a document's blocks read as a deck, which no deck's HTML can be written
 *   from.
 */
type LiveContent =
	| { readonly outcome: "whole" | "partly"; readonly content: Node }
	| { readonly outcome: "notADeck" };

/**
 * The content of a document of `kind` (see `LiveContent`), with what is
 * suggested for whole blocks marked on them as the document carries it.
 *
 * Reading shared content deletes whatever this schema cannot hold, such as a
 * block written by a newer version of the app, or all of it when read as
 * another kind. So it is read from a copy, which is thrown away, and the
 * document itself keeps everything.
 */
function read(document: Document, kind: LiveArtifactKind): LiveContent {
	const copy = new Doc();
	applyUpdate(copy, encodeStateAsUpdate(document));
	const shared = copy.getXmlFragment(LIVE_DOCUMENT_CONTENT);
	const before = sizeOf(shared);
	const content = suggestionsFromAttributes(
		yXmlFragmentToProseMirrorRootNode(shared, liveDocumentSchema(kind)),
	);
	const after = sizeOf(shared);
	const lost = after.blocks !== before.blocks || after.text !== before.text;
	const fits = fitsSchema(content);
	if (kind === "slides" && !fits) return { outcome: "notADeck" };
	return { outcome: lost || !fits ? "partly" : "whole", content };
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

/** Beside the artifact's versions, so it is deleted with them. */
const stateKey = (artifactId: string) => BlobStore.key("artifacts", artifactId, "live");

/** The caret colour agents are shown with. */
const AGENT_COLOR = "#0d9488";

/** How long people see an agent's name in the document after it writes. */
const AGENT_SHOWN_FOR = "6 seconds";

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
