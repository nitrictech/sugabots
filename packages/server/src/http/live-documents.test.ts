import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { Artifact } from "@sugabots/contracts";
import { LIVE_DOCUMENT_SCHEMA } from "@sugabots/contracts/live-document";
import { Artifacts } from "@sugabots/core/artifacts/artifacts";
import { LiveDocuments } from "@sugabots/core/artifacts/live";
import { BlobStore } from "@sugabots/core/blob-store/blob-store";
import { Ids } from "@sugabots/core/ids/ids";
import { unimplemented } from "@sugabots/core/testing";
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Doc, type XmlElement } from "yjs";
import { identifiedBy, testRoutes, type UserResolver, WEB_ORIGIN } from "./app.test-support.ts";

/**
 * A document's live WebSocket, served on a real port: the editor's sync
 * client joins through the API's route while an agent rewrites the same
 * document in the process.
 */
const user = {
	id: "0199a3a0-0000-7000-8000-0000000000ff",
	email: "sam@example.com",
	name: "Sam",
	image: null,
};
const resolveUser: UserResolver = async (headers) =>
	headers.get("cookie") === "session=good" ? user : null;

const POD_ID = "0199a3a0-0000-7000-8000-000000000001";
const ARTIFACT_ID = "0199a3a0-0000-7000-8000-000000000002";
const LIVE = `/api/pods/${POD_ID}/artifacts/${ARTIFACT_ID}/live`;
const PATH = `${LIVE}?schema=${LIVE_DOCUMENT_SCHEMA}`;
const WORD_PATH = `/api/pods/${POD_ID}/artifacts/${ARTIFACT_ID}/word`;

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

const PLANNER = {
	name: "Planner",
	threadId: "0199a3a0-0000-7000-8000-000000000003",
	look: { color: "green", face: "pill", shape: "circle" },
} as const;

const scope = Effect.runSync(Scope.make());
let apiPort: number;
let live: LiveDocuments.Interface;

beforeAll(async () => {
	const blobs = new Map<string, Uint8Array>();
	live = await Effect.runPromise(
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
			Effect.provide(Ids.layer),
			Scope.provide(scope),
		),
	);
	apiPort = await Effect.runPromise(
		Effect.gen(function* () {
			const routes = testRoutes(
				Layer.mergeAll(
					identifiedBy(resolveUser),
					unimplemented(Artifacts.Service, { get: () => Effect.succeed(plan) }),
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

afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));

describe("a document's live WebSocket", () => {
	it("syncs a signed-in person's editor with an agent's rewrite of the same document", async () => {
		const person = await joinAs("session=good");

		expect(textOf(person.document)).toBe("Launch planShip on Friday.");

		await Effect.runPromise(
			live.rewrite(ARTIFACT_ID, PLANNER, (markdown) =>
				markdown.replace("Ship on Friday.", "Ship on Monday."),
			),
		);

		await until(() => textOf(person.document).includes("Ship on Monday."));
		expect(namesIn(person)).toContain("Planner");
		person.leave();
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

	it("gives nobody the Word file without a session", async () => {
		const response = await fetch(`http://127.0.0.1:${apiPort}${WORD_PATH}`);

		expect(response.status).toBe(401);
	});

	it("refuses an editor built for another schema, which would delete what it could not hold", async () => {
		const socket = new WebSocket(`ws://127.0.0.1:${apiPort}${LIVE}?schema=1`, {
			headers: { origin: WEB_ORIGIN, cookie: "session=good" },
		} as unknown as string[]);
		const outcome = await new Promise<string>((resolve) => {
			socket.onopen = () => resolve("opened");
			socket.onerror = () => resolve("refused");
		});

		expect(outcome).toBe("refused");
	});

	it("refuses a socket nobody is signed in on", async () => {
		const socket = new WebSocket(`ws://127.0.0.1:${apiPort}${PATH}`, {
			headers: { origin: WEB_ORIGIN, cookie: "session=bad" },
		} as unknown as string[]);
		const outcome = await new Promise<string>((resolve) => {
			socket.onopen = () => resolve("opened");
			socket.onerror = () => resolve("refused");
		});

		expect(outcome).toBe("refused");
	});
});

/** The web app's sync client on the route, signed in by `cookie` as a browser on the web app's origin would be. */
async function joinAs(cookie: string) {
	class BrowserSocket extends WebSocket {
		constructor(url: string) {
			super(url, { headers: { origin: WEB_ORIGIN, cookie } } as unknown as string[]);
		}
	}
	const socket = new HocuspocusProviderWebsocket({
		url: `ws://127.0.0.1:${apiPort}${PATH}`,
		WebSocketPolyfill: BrowserSocket,
	});
	const provider = new HocuspocusProvider({
		name: ARTIFACT_ID,
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
