import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import {
	type Artifact,
	isEditedLive,
	LIVE_EDITOR_REFUSED_CLOSE_CODE,
	liveEditorQuerySchema,
} from "@sugabots/contracts";
import { artifactImageAddress, artifactImageIds } from "@sugabots/contracts/http";
import { LIVE_DOCUMENT_SCHEMA } from "@sugabots/contracts/live-document";
import { Artifacts } from "@sugabots/core/artifacts/artifacts";
import { LiveDocuments } from "@sugabots/core/artifacts/live";
import { BlobStore } from "@sugabots/core/blob-store/blob-store";
import { artifact, pod, workspace } from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { unimplemented } from "@sugabots/core/testing";
import { Context, Effect, Exit, Layer, Schema, Scope, Stream } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Doc, type XmlElement } from "yjs";
import { identifiedBy, testRoutes, type UserResolver, WEB_ORIGIN } from "./app.test-support.ts";

/**
 * A document's live WebSocket, served on a real port: the editor's sync
 * client joins through the API's route while an agent rewrites the same
 * document in the process. The live documents read each artifact's kind from
 * its row, so the artifacts here have rows in the test database, under ids
 * of their own each run.
 */
const user = {
	id: "0199a3a0-0000-7000-8000-0000000000ff",
	email: "sam@example.com",
	name: "Sam",
	image: null,
};
const resolveUser: UserResolver = async (headers) =>
	headers.get("cookie") === "session=good" ? user : null;

const POD_ID = randomUUID();
const ARTIFACT_ID = randomUUID();
const WORD_PATH = `/api/pods/${POD_ID}/artifacts/${ARTIFACT_ID}/word`;
const DECK_ID = randomUUID();
const POWERPOINT_PATH = `/api/pods/${POD_ID}/artifacts/${DECK_ID}/powerpoint`;
const PDF_PATH = `/api/pods/${POD_ID}/artifacts/${DECK_ID}/pdf`;

const plan: Artifact = {
	id: ARTIFACT_ID,
	podId: POD_ID,
	kind: "document",
	title: "Launch plan",
	version: 1,
	createdBy: null,
	createdAt: "2026-11-23T00:00:00.000Z",
	updatedAt: "2026-11-23T00:00:00.000Z",
	content: "# Launch plan\n\nShip on Friday.",
	shownVersion: { number: 1, author: null, createdAt: "2026-11-23T00:00:00.000Z" },
};

const ILLUSTRATED_ID = randomUUID();

/** A slide of `layout` whose title box holds `title`, and, under it, `body`, placed where the layout puts them. */
const slide = (layout: string, title: string, body?: string) =>
	`<section data-slide data-layout="${layout}"><div data-slide-body><div data-slide-box data-role="title">${title}</div>${body === undefined ? "" : `<div data-slide-box data-role="body">${body}</div>`}</div></section>`;

/** A deck of two slides, which is edited live as a document is. */
const deck: Artifact = {
	...plan,
	id: DECK_ID,
	kind: "slides",
	title: "Launch review",
	content: [
		slide("title", "<h1>Launch review</h1>"),
		slide("bullets", "<h2>Goals</h2>", "<ul><li><p>Ship on Friday</p></li></ul>"),
	].join("\n"),
};

/** The address of an image kept for `artifactId`. */
function imageKeptFor(artifactId: string): string {
	const ids = artifactImageIds({ podId: POD_ID, artifactId, imageId: "f".repeat(64) });
	if (!ids) throw new Error("fixture");
	return artifactImageAddress(ids);
}

/**
 * A document showing one of its own images and one kept for another
 * artifact, which `Artifacts` here would serve as readily.
 */
const illustrated: Artifact = {
	...plan,
	id: ILLUSTRATED_ID,
	title: "Illustrated plan",
	content: `# Illustrated plan\n\n![Our chart](${imageKeptFor(ILLUSTRATED_ID)})\n\n![Their chart](${imageKeptFor(ARTIFACT_ID)})`,
};

/** A one-pixel PNG. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

const PLANNER = {
	name: "Planner",
	threadId: "0199a3a0-0000-7000-8000-000000000003",
	look: { color: "green", face: "pill", shape: "circle" },
} as const;

const scope = Effect.runSync(Scope.make());
let apiPort: number;
let live: LiveDocuments.Interface;

describe.skipIf(!process.env.DATABASE_URL)("a document's live WebSocket", () => {
	beforeAll(async () => {
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Launch", slug: `launch-${POD_ID}` })
				.returning(),
		);
		if (!space) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(pod).values({
				id: POD_ID,
				workspaceId: space.id,
				kind: "shared",
				name: "Launch",
				slug: "launch",
			}),
		);
		await onDatabase((db) =>
			db.insert(artifact).values(
				[plan, deck, illustrated].map(({ id, kind, title }) => ({
					id,
					workspaceId: space.id,
					podId: POD_ID,
					kind,
					title,
				})),
			),
		);
		const blobs = new Map<string, Uint8Array>();
		live = await runOnPostgres(
			LiveDocuments.make.pipe(
				Effect.provide(
					unimplemented(BlobStore.Service, {
						get: (key) =>
							Effect.fromNullishOr(blobs.get(key)).pipe(
								Effect.map((bytes) => ({
									stream: Stream.succeed(bytes),
									contentType: "application/octet-stream",
									size: bytes.length,
								})),
								Effect.mapError(() => new BlobStore.NotFound({ key })),
							),
						put: (key, content) =>
							Stream.runCollect(content.stream).pipe(
								Effect.map((chunks) => {
									const bytes = Buffer.concat(chunks);
									blobs.set(key, bytes);
									return { size: bytes.length };
								}),
							),
					}),
				),
				Scope.provide(scope),
			),
		);
		apiPort = await Effect.runPromise(
			Effect.gen(function* () {
				const routes = testRoutes(
					Layer.mergeAll(
						identifiedBy(resolveUser),
						unimplemented(Artifacts.Service, {
							get: ({ artifactId }) =>
								Effect.succeed([illustrated, deck].find(({ id }) => id === artifactId) ?? plan),
							image: () =>
								Effect.succeed({
									contentType: "image/png",
									size: PNG.byteLength,
									stream: Stream.succeed(PNG),
								}),
						}),
						Layer.succeed(LiveDocuments.Service, live),
					),
				);
				const context = yield* Layer.buildWithScope(
					HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
						Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 })),
					),
					scope,
				);
				const address = Context.get(context, HttpServer.HttpServer).address;
				return "port" in address ? address.port : 0;
				// The routes' requirements are the router's own, which serving provides.
			}).pipe(Effect.orDie) as Effect.Effect<number>,
		);
	});

	afterAll(async () => {
		await Effect.runPromise(Scope.close(scope, Exit.void));
		await closeDatabase();
	});

	it("syncs a signed-in person's editor with an agent's rewrite of the same document", async () => {
		const person = await joinAs("session=good");

		expect(textOf(person.document)).toBe("Launch planShip on Friday.");

		await Effect.runPromise(
			live.rewrite(ARTIFACT_ID, PLANNER, (text) =>
				text.replace("Ship on Friday.", "Ship on Monday."),
			),
		);

		await until(() => textOf(person.document).includes("Ship on Monday."));
		expect(namesIn(person)).toContain("Planner");
		person.leave();
	});

	it("syncs a person's editor with an agent's rewrite of a deck, as of a document", async () => {
		const person = await joinAs("session=good", deck);
		const textOfDeck = () => person.document.getXmlFragment("default").toString();

		expect(textOfDeck()).toContain("Ship on Friday");

		await Effect.runPromise(
			live.rewrite(DECK_ID, PLANNER, (text) => text.replace("Ship on Friday", "Ship on Monday")),
		);

		await until(() => textOfDeck().includes("Ship on Monday"));
		expect(person.document.getXmlFragment("default").get(1)).toMatchObject({ nodeName: "slide" });
		person.leave();
	});

	it("gives no Word file for a deck", async () => {
		const response = await fetch(
			`http://127.0.0.1:${apiPort}/api/pods/${POD_ID}/artifacts/${DECK_ID}/word`,
			{ headers: { cookie: "session=good" } },
		);

		expect(response.status).toBe(404);
	});

	it("downloads the document as a Word file holding what the live document holds", async () => {
		const response = await fetch(`http://127.0.0.1:${apiPort}${WORD_PATH}`, {
			headers: { cookie: "session=good" },
		});
		const file = new Uint8Array(await response.arrayBuffer());

		expect(response.status).toBe(200);
		expect(response.headers.get("content-disposition")).toContain("Launch%20plan.docx");
		// A .docx is a zip, which starts with these two letters.
		expect(new TextDecoder().decode(file.slice(0, 2))).toBe("PK");
	});

	it("puts the document's own image in its Word file, and no other", async () => {
		const response = await fetch(
			`http://127.0.0.1:${apiPort}/api/pods/${POD_ID}/artifacts/${ILLUSTRATED_ID}/word`,
			{ headers: { cookie: "session=good" } },
		);
		const file = new Uint8Array(await response.arrayBuffer());

		expect(response.status).toBe(200);
		// A .docx is a zip, whose list of files is plain text: one image is among them.
		const media = new TextDecoder().decode(file).match(/word\/media\/[\w-]+\.png/g) ?? [];
		expect(new Set(media).size).toBe(1);
	});

	it("downloads a deck as a PowerPoint file holding what the live deck holds", async () => {
		const person = await joinAs("session=good", deck);
		await Effect.runPromise(
			live.rewrite(
				DECK_ID,
				PLANNER,
				(text) => `${text}\n${slide("section", "<h2>Next steps</h2>")}`,
			),
		);

		const response = await fetch(`http://127.0.0.1:${apiPort}${POWERPOINT_PATH}`, {
			headers: { cookie: "session=good" },
		});
		const file = new Uint8Array(await response.arrayBuffer());
		person.leave();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		);
		expect(response.headers.get("content-disposition")).toContain("Launch%20review.pptx");
		// A .pptx is a zip, whose list of files is plain text: a slide for each of the live deck's three.
		const slides = new TextDecoder().decode(file).match(/ppt\/slides\/slide\d+\.xml/g) ?? [];
		expect([...new Set(slides)].sort()).toEqual([
			"ppt/slides/slide1.xml",
			"ppt/slides/slide2.xml",
			"ppt/slides/slide3.xml",
		]);
	});

	it("gives no PowerPoint file for a document", async () => {
		const response = await fetch(
			`http://127.0.0.1:${apiPort}/api/pods/${POD_ID}/artifacts/${ARTIFACT_ID}/powerpoint`,
			{ headers: { cookie: "session=good" } },
		);

		expect(response.status).toBe(404);
	});

	it("downloads a deck as a PDF holding what the live deck holds", async () => {
		const person = await joinAs("session=good", deck);
		await Effect.runPromise(
			live.rewrite(DECK_ID, PLANNER, () =>
				[deck.content, slide("section", "<h2>Next steps</h2>")].join("\n"),
			),
		);

		const response = await fetch(`http://127.0.0.1:${apiPort}${PDF_PATH}`, {
			headers: { cookie: "session=good" },
		});
		const file = new TextDecoder("latin1").decode(await response.arrayBuffer());
		person.leave();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/pdf");
		expect(response.headers.get("content-disposition")).toContain("Launch%20review.pdf");
		expect(file.startsWith("%PDF-")).toBe(true);
		// A PDF's page objects are plain text in it: a page for each of the live deck's three slides.
		expect(file.match(/\/Type \/Page\b(?!s)/g)).toHaveLength(3);
	});

	it("gives no PDF for a document", async () => {
		const response = await fetch(
			`http://127.0.0.1:${apiPort}/api/pods/${POD_ID}/artifacts/${ARTIFACT_ID}/pdf`,
			{ headers: { cookie: "session=good" } },
		);

		expect(response.status).toBe(404);
	});

	it("gives nobody the Word file without a session", async () => {
		const response = await fetch(`http://127.0.0.1:${apiPort}${WORD_PATH}`);

		expect(response.status).toBe(401);
	});

	it("refuses an editor built for another schema, which would delete what it could not hold", async () => {
		const code = await closeCodeFor(ARTIFACT_ID, { schema: 1, kind: "document" });

		expect(code).toBe(LIVE_EDITOR_REFUSED_CLOSE_CODE);
	});

	it("lets an editor join only an artifact of the kind it was built for", async () => {
		const deckAsDocument = await closeCodeFor(DECK_ID, {
			schema: LIVE_DOCUMENT_SCHEMA,
			kind: "document",
		});
		const documentAsDeck = await closeCodeFor(ARTIFACT_ID, {
			schema: LIVE_DOCUMENT_SCHEMA,
			kind: "slides",
		});
		const onDocument = await joinAs("session=good", plan);
		const onDeck = await joinAs("session=good", deck);

		expect([deckAsDocument, documentAsDeck]).toEqual([
			LIVE_EDITOR_REFUSED_CLOSE_CODE,
			LIVE_EDITOR_REFUSED_CLOSE_CODE,
		]);
		expect(onDocument.document.getXmlFragment("default").get(0)).toMatchObject({
			nodeName: "heading",
		});
		expect(onDeck.document.getXmlFragment("default").get(0)).toMatchObject({ nodeName: "slide" });
		onDocument.leave();
		onDeck.leave();
	});

	it("refuses a socket nobody is signed in on", async () => {
		const builtFor = { schema: LIVE_DOCUMENT_SCHEMA, kind: "document" } as const;
		const socket = new WebSocket(liveAddress(ARTIFACT_ID, builtFor), {
			headers: { origin: WEB_ORIGIN, cookie: "session=bad" },
		} as unknown as string[]);
		const outcome = await new Promise<string>((resolve) => {
			socket.onopen = () => resolve("opened");
			socket.onerror = () => resolve("refused");
		});

		expect(outcome).toBe("refused");
	});
});

/**
 * The web app's sync client on `artifact`'s route, built for the artifact's
 * kind, signed in by `cookie` as a browser on the web app's origin would be.
 */
async function joinAs(cookie: string, artifact: Artifact = plan) {
	class BrowserSocket extends WebSocket {
		constructor(url: string) {
			super(url, { headers: { origin: WEB_ORIGIN, cookie } } as unknown as string[]);
		}
	}
	if (!isEditedLive(artifact)) throw new Error("fixture");
	const socket = new HocuspocusProviderWebsocket({
		url: liveAddress(artifact.id, { schema: LIVE_DOCUMENT_SCHEMA, kind: artifact.kind }),
		WebSocketPolyfill: BrowserSocket,
	});
	const provider = new HocuspocusProvider({
		name: artifact.id,
		document: new Doc(),
		websocketProvider: socket,
	});
	const synced = new Promise((resolve) => provider.on("synced", resolve));
	// A provider handed its socket neither starts listening to it nor closes it by itself.
	provider.attach();
	await synced;
	return {
		document: provider.document,
		awareness: provider.awareness,
		leave: () => {
			provider.destroy();
			socket.destroy();
		},
	};
}

/** What an editor says it was built for when it joins. */
type BuiltFor = typeof liveEditorQuerySchema.Type;

/** The address of `artifactId`'s live route, as an editor built for `builtFor` opens it. */
const liveAddress = (artifactId: string, builtFor: BuiltFor) =>
	`ws://127.0.0.1:${apiPort}/api/pods/${POD_ID}/artifacts/${artifactId}/live?${new URLSearchParams(Schema.encodeSync(liveEditorQuerySchema)(builtFor))}`;

/**
 * The code the route closes the socket with that an editor built for
 * `builtFor` opens on `artifactId`, signed in, from the web app's origin.
 * Fails if the socket is still open after a while, as it is when let in.
 */
async function closeCodeFor(artifactId: string, builtFor: BuiltFor): Promise<number> {
	const socket = new WebSocket(liveAddress(artifactId, builtFor), {
		headers: { origin: WEB_ORIGIN, cookie: "session=good" },
	} as unknown as string[]);
	try {
		return await new Promise<number>((resolve, reject) => {
			socket.onclose = (event) => resolve(event.code);
			setTimeout(
				() => reject(new Error(`The socket was still open after ${CLOSE_WAIT_MS} ms`)),
				CLOSE_WAIT_MS,
			);
		});
	} finally {
		socket.close();
	}
}

/** How long a socket the route refuses may take to be closed. */
const CLOSE_WAIT_MS = 2_000;

const textOf = (document: Doc) =>
	document
		.getXmlFragment("default")
		.toArray()
		.map((block) => (block as XmlElement).toArray().join(""))
		.join("");

const namesIn = (person: Pick<HocuspocusProvider, "awareness">) =>
	[...(person.awareness?.getStates().values() ?? [])].map(
		(state) => (state.user as { name: string } | undefined)?.name,
	);

async function until(condition: () => boolean) {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Waited 5 seconds for the document to catch up");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
