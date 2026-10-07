import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { DesktopViewer } from "@sugabots/core/conversations/tools/browser/viewer";
import { answerChallenge } from "@sugabots/core/conversations/tools/browser/vnc-authentication";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import {
	HttpRouter,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createTestApp,
	identifiedBy,
	testRoutes,
	type UserResolver,
	WEB_ORIGIN,
} from "./app.test-support.ts";

/**
 * The desktop viewer's WebSocket, served on real ports: the API relays the
 * person's socket to the desktop's, here a stand-in that logs a viewer in as
 * x11vnc does, with VNC authentication, then echoes what it is sent.
 */
const user = {
	id: "0199a3a0-0000-7000-8000-0000000000ff",
	email: "sam@example.com",
	name: "Sam",
	image: null,
};
const resolveUser: UserResolver = async (headers) =>
	headers.get("cookie") === "session=good" ? user : null;
const PATH =
	"/api/threads/0199a3a0-0000-7000-8000-000000000001/agents/0199a3a0-0000-7000-8000-000000000002/desktop";

const PASSWORD = "Abc-12_x";
const CHALLENGE = Uint8Array.from({ length: 16 }, (_, index) => index * 7);

const scope = Effect.runSync(Scope.make());
let apiPort: number;

/** Serves `routes` on an ephemeral port until the tests end, and answers the port. */
const served = <E, R>(routes: Layer.Layer<never, E, R>) =>
	Effect.runPromise(
		Effect.gen(function* () {
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

beforeAll(async () => {
	const desktopPort = await served(
		Layer.effectDiscard(
			Effect.gen(function* () {
				const router = yield* HttpRouter.HttpRouter;
				yield* router.add(
					"GET",
					"/",
					Effect.gen(function* () {
						const socket = yield* (yield* HttpServerRequest.HttpServerRequest).upgrade;
						yield* Effect.scoped(
							Effect.gen(function* () {
								const write = yield* socket.writer;
								const read = yield* socket.reader;
								// One frame for each of the viewer's steps, as the relay sends them.
								const next = Effect.map(read.pull, ([frame]) =>
									typeof frame === "string" ? new TextEncoder().encode(frame) : frame,
								);
								yield* write.write("RFB 003.008\n");
								yield* next;
								yield* write.write(Uint8Array.of(1, 2));
								yield* next;
								yield* write.write(CHALLENGE);
								const answer = yield* next;
								const expected = answerChallenge(PASSWORD, CHALLENGE);
								if (answer?.join() !== expected.join()) {
									return yield* write.write(Uint8Array.of(0, 0, 0, 1));
								}
								yield* write.write(Uint8Array.of(0, 0, 0, 0));
								return yield* read.pull.pipe(
									Effect.flatMap((frames) => Effect.forEach(frames, (frame) => write.write(frame))),
									Effect.forever,
								);
							}),
						).pipe(Effect.ignore);
						return HttpServerResponse.empty();
					}),
				);
			}),
		),
	);
	apiPort = await served(
		testRoutes(
			Layer.mergeAll(
				identifiedBy(resolveUser),
				Layer.succeed(DesktopViewer.Service, {
					open: () =>
						Effect.succeed({
							endpoint: { url: `http://127.0.0.1:${desktopPort}`, headers: {} },
							password: PASSWORD,
						}),
				}),
			),
		),
	);
});

afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));

describe("the desktop viewer's WebSocket", () => {
	it("logs a signed-in person in to the desktop without its password, then relays both ways", async () => {
		const socket = new WebSocket(`ws://127.0.0.1:${apiPort}${PATH}`, {
			headers: { origin: WEB_ORIGIN, cookie: "session=good" },
		} as unknown as string[]);
		socket.binaryType = "arraybuffer";
		const frames: number[][] = [];
		// What noVNC sends at each step: its version, no authentication, then a message.
		const replies = [new TextEncoder().encode("RFB 003.008\n"), Uint8Array.of(1), undefined];
		await new Promise<void>((resolve, reject) => {
			socket.onmessage = (event) => {
				frames.push([...new Uint8Array(event.data as ArrayBuffer)]);
				if (frames.length <= replies.length) {
					const reply = replies[frames.length - 1];
					socket.send(reply ?? new TextEncoder().encode("hello"));
				}
				if (frames.length === 4) resolve();
			};
			socket.onerror = () => reject(new Error("The socket failed"));
		});
		socket.close();

		expect(frames.map((frame) => new TextDecoder().decode(Uint8Array.from(frame)))).toEqual([
			"RFB 003.008\n",
			"\u0001\u0001",
			"\u0000\u0000\u0000\u0000",
			"hello",
		]);
	});

	it("refuses a page on another origin, cookie or not", async () => {
		const response = await createTestApp(identifiedBy(resolveUser)).fetch(
			new Request(`http://localhost:3000${PATH}`, {
				headers: { origin: "https://elsewhere.example", cookie: "session=good" },
			}),
		);

		expect(response.status).toBe(403);
	});

	it("refuses somebody who isn't signed in", async () => {
		const response = await createTestApp(identifiedBy(resolveUser)).fetch(
			new Request(`http://localhost:3000${PATH}`, { headers: { origin: WEB_ORIGIN } }),
		);

		expect(response.status).toBe(401);
	});
});
