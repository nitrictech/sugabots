import { API_BASE_PATH } from "@sugabots/contracts/http";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { DesktopViewer } from "@sugabots/core/conversations/tools/browser/viewer";
import {
	answerChallenge,
	CHALLENGE_BYTES,
} from "@sugabots/core/conversations/tools/browser/vnc-authentication";
import { Installation } from "@sugabots/core/installation/installation";
import type { Sandboxes } from "@sugabots/core/sandboxes/sandboxes";
import { Data, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";
import { Authentication } from "../auth/authentication.ts";

/**
 * An agent's desktop in a thread, live: WebSockets the web app's desktop
 * opens, relayed to servers in the sandbox. Each window's is noVNC's,
 * relayed to the VNC server of the window's display: the relay logs in to
 * the server with its password and offers the viewer no authentication, then
 * passes frames both ways untouched. The browser's tabs, the terminal and the
 * list of windows are relayed to the desktop's server, with the password in
 * the upgrade request. Neither the passwords nor the sandbox's address reach
 * the person's browser.
 */
export const desktopViewerRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const authentication = yield* Authentication.Service;
		const viewer = yield* DesktopViewer.Service;
		const trusted = new Set((yield* Installation.Service).trustedOrigins);

		/**
		 * A viewer's WebSocket at `path`, under the agent in the thread: what
		 * `open` gives for the path's parameters is opened before the person's
		 * socket is upgraded, so a refusal is an HTTP status, then `relay` joins
		 * the two.
		 */
		const route = (
			path: string,
			open: (
				params: { threadId: string; agentId: string } & Readonly<
					Record<string, string | undefined>
				>,
			) => ReturnType<typeof viewer.openDesktopServer>,
			relay: (browserSide: Socket.Socket, opened: DesktopViewer.OpenServer) => Effect.Effect<void>,
		) =>
			router.add(
				"GET",
				`${API_BASE_PATH}/threads/:threadId/agents/:agentId/${path}`,
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					// Any page the browser visits can open a WebSocket here with the
					// person's cookie, so only the web app's own origin may.
					if (!request.headers.origin || !trusted.has(request.headers.origin)) {
						return HttpServerResponse.text("Untrusted origin", { status: 403 });
					}
					const holder = yield* authentication.identify(new Headers(request.headers));
					if (!holder) return HttpServerResponse.text("Sign in first", { status: 401 });
					const params = yield* HttpRouter.params;
					const { threadId, agentId } = params;
					if (!threadId || !agentId) return HttpServerResponse.empty({ status: 404 });

					return yield* Effect.scoped(
						Effect.gen(function* () {
							const opened = yield* open({ ...params, threadId, agentId });
							const browserSide = yield* request.upgrade;
							yield* relay(browserSide, opened);
							return HttpServerResponse.empty();
						}),
					).pipe(
						CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(holder.user.id)),
						Effect.catchTags({
							DesktopUnavailable: (failure) =>
								Effect.succeed(HttpServerResponse.text(failure.userMessage, { status: 404 })),
							ResourceHidden: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
							ActionForbidden: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
						}),
					);
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning(`The desktop viewer's connection at ${path} ended badly`, cause).pipe(
							Effect.as(HttpServerResponse.empty({ status: 502 })),
						),
					),
				),
			);

		yield* route(
			"windows/:window",
			({ window = "", ...turn }) => viewer.openWindow({ ...turn, window }),
			(browserSide, display) => relay(browserSide, upstream(display.endpoint), display.password),
		);
		for (const channel of DESKTOP_SERVER_CHANNELS) {
			yield* route(`desktop/${channel}`, viewer.openDesktopServer, (browserSide, server) =>
				pipe(browserSide, desktopServer(server, channel)),
			);
		}
	}),
);

/** What the desktop's server serves, each at its own path. */
const DESKTOP_SERVER_CHANNELS = ["tabs", "terminal", "files", "windows"] as const;

/**
 * The desktop's server in the sandbox as a WebSocket at `channel`, logged in
 * to with the password as a bearer token.
 */
function desktopServer(
	server: DesktopViewer.OpenServer,
	channel: (typeof DESKTOP_SERVER_CHANNELS)[number],
) {
	return Socket.fromWebSocket(
		Effect.acquireRelease(
			Effect.sync(
				() =>
					new WebSocket(`${server.endpoint.url.replace(/^http/, "ws")}/${channel}`, {
						headers: { ...server.endpoint.headers, authorization: `Bearer ${server.password}` },
					} as unknown as string[]),
			),
			(socket) => Effect.sync(() => socket.close()),
		),
		{ openTimeout: "10 seconds" },
	);
}

/** Copies messages each way, text as text, until either side closes. */
function pipe(browserSide: Socket.Socket, serverSide: Effect.Effect<Socket.Socket>) {
	return Effect.scoped(
		Effect.gen(function* () {
			const server = yield* serverSide;
			const [fromBrowser, fromServer] = yield* Effect.all([browserSide.reader, server.reader]);
			const [toBrowser, toServer] = yield* Effect.all([browserSide.writer, server.writer]);
			const copy = (from: Socket.Reader, to: Socket.Writer) =>
				from.pull.pipe(
					Effect.flatMap((messages) =>
						Effect.forEach(messages, (message) => to.write(message), { discard: true }),
					),
					Effect.forever,
				);
			return yield* Effect.raceFirst(copy(fromBrowser, toServer), copy(fromServer, toBrowser));
		}),
	).pipe(Effect.ignore);
}

/**
 * A display's VNC server as a WebSocket, reached through the sandbox
 * provider: websockify in front of Xvnc, or x11vnc itself in sandboxes made
 * from images before Xvnc.
 */
function upstream(desktop: Sandboxes.Endpoint) {
	const url = desktop.url.replace(/^http/, "ws");
	return Socket.fromWebSocket(
		Effect.acquireRelease(
			Effect.sync(
				// Node's WebSocket takes headers as well as protocols: a provider
				// may need them to route the request, and x11vnc refuses a
				// handshake without an Origin, which only browsers send unasked.
				() =>
					new WebSocket(url, {
						protocols: [VNC_SUBPROTOCOL],
						headers: { ...desktop.headers, origin: RELAY_ORIGIN },
					} as unknown as string[]),
			),
			(socket) => Effect.sync(() => socket.close()),
		),
		{ openTimeout: "10 seconds" },
	);
}

/**
 * Logs in to the desktop for the person, then copies frames each way until
 * either side closes.
 */
function relay(
	browserSide: Socket.Socket,
	desktopSide: Effect.Effect<Socket.Socket>,
	password: string,
) {
	return Effect.scoped(
		Effect.gen(function* () {
			const desktopSocket = yield* desktopSide;
			const browser = bytesOf(yield* browserSide.reader);
			const desktop = bytesOf(yield* desktopSocket.reader);
			const [toBrowser, toDesktop] = yield* Effect.all([browserSide.writer, desktopSocket.writer]);
			yield* logIn({ browser, toBrowser, desktop, toDesktop, password });
			const pump = (from: Bytes, to: Socket.Writer) =>
				Effect.gen(function* () {
					const unread = from.rest();
					if (unread.length > 0) yield* to.write(unread);
					return yield* from.reader.pull.pipe(
						Effect.flatMap((frames) =>
							Effect.forEach(frames, (frame) => to.write(frame), { discard: true }),
						),
						Effect.forever,
					);
				});
			return yield* Effect.raceFirst(pump(browser, toDesktop), pump(desktop, toBrowser));
		}),
	).pipe(
		Effect.catchTag("DesktopLoginFailed", (failure) =>
			Effect.logWarning(`Couldn't log in to the desktop for its viewer: ${failure.reason}`),
		),
		Effect.ignore,
	);
}

/**
 * The start of RFB 3.8 (RFC 6143, 7.1-7.1.3) between the two sides: the
 * relay answers the desktop's VNC authentication, and tells the viewer it
 * needs none.
 */
function logIn({
	browser,
	toBrowser,
	desktop,
	toDesktop,
	password,
}: {
	browser: Bytes;
	toBrowser: Socket.Writer;
	desktop: Bytes;
	toDesktop: Socket.Writer;
	password: string;
}) {
	return Effect.gen(function* () {
		const version = yield* desktop.take(VERSION_BYTES);
		yield* toBrowser.write(version);
		const viewerVersion = yield* browser.take(VERSION_BYTES);
		if (new TextDecoder().decode(viewerVersion) !== RFB_3_8) {
			return yield* new DesktopLoginFailed({ reason: "the viewer doesn't speak RFB 3.8" });
		}
		yield* toDesktop.write(viewerVersion);
		const [offered = 0] = yield* desktop.take(1);
		const securityTypes = yield* desktop.take(offered);
		if (!securityTypes.includes(VNC_AUTHENTICATION)) {
			return yield* new DesktopLoginFailed({ reason: "the desktop doesn't ask for a password" });
		}
		yield* toBrowser.write(Uint8Array.of(1, NO_AUTHENTICATION));
		const [chosen] = yield* browser.take(1);
		if (chosen !== NO_AUTHENTICATION) {
			return yield* new DesktopLoginFailed({ reason: "the viewer chose another security type" });
		}
		yield* toDesktop.write(Uint8Array.of(VNC_AUTHENTICATION));
		const challenge = yield* desktop.take(CHALLENGE_BYTES);
		yield* toDesktop.write(answerChallenge(password, challenge));
		const result = yield* desktop.take(SECURITY_RESULT_BYTES);
		if (result.some((byte) => byte !== 0)) {
			return yield* new DesktopLoginFailed({ reason: "the desktop refused its password" });
		}
		yield* toBrowser.write(result);
	});
}

/** A socket's frames as bytes, read a given number at a time. */
interface Bytes {
	readonly reader: Socket.Reader;
	/** The next `count` bytes, waiting for frames until they've arrived. */
	readonly take: (count: number) => Effect.Effect<Uint8Array, Socket.SocketError>;
	/** What has arrived and not been taken, which leaves it. */
	readonly rest: () => Uint8Array;
}

function bytesOf(reader: Socket.Reader): Bytes {
	let buffered = new Uint8Array(0);
	const encoder = new TextEncoder();
	return {
		reader,
		take: (count) =>
			Effect.gen(function* () {
				while (buffered.length < count) {
					const frames = yield* reader.pull;
					buffered = concatenated([
						buffered,
						...frames.map((frame) => (typeof frame === "string" ? encoder.encode(frame) : frame)),
					]);
				}
				const taken = buffered.slice(0, count);
				buffered = buffered.slice(count);
				return taken;
			}),
		rest: () => {
			const unread = buffered;
			buffered = new Uint8Array(0);
			return unread;
		},
	};
}

function concatenated(parts: readonly Uint8Array[]) {
	const whole = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		whole.set(part, offset);
		offset += part.length;
	}
	return whole;
}

/** The desktop and its viewer couldn't be joined, for `reason`. */
class DesktopLoginFailed extends Data.TaggedError("DesktopLoginFailed")<{ reason: string }> {}

const RFB_3_8 = "RFB 003.008\n";
const VERSION_BYTES = RFB_3_8.length;
const NO_AUTHENTICATION = 1;
const VNC_AUTHENTICATION = 2;
const SECURITY_RESULT_BYTES = 4;

/** Asks for VNC's bytes as they are rather than as base64 text. */
const VNC_SUBPROTOCOL = "binary";

/**
 * Any origin satisfies x11vnc, which only checks that one is given, and
 * websockify, which doesn't check.
 */
const RELAY_ORIGIN = "http://sugabots-desktop-relay";
