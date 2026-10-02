import { API_BASE_PATH } from "@sugabots/contracts/http";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { DesktopViewer } from "@sugabots/core/conversations/tools/browser/viewer";
import { Installation } from "@sugabots/core/installation/installation";
import type { Sandboxes } from "@sugabots/core/sandboxes/sandboxes";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";
import { Authentication } from "../auth/authentication.ts";

/**
 * An agent's desktop in a thread, live: a WebSocket the web app's noVNC
 * viewer opens, relayed to the desktop's VNC server in the sandbox.
 * The viewer's frames go both ways untouched; the sandbox's address never
 * reaches the browser.
 */
export const desktopViewerRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const authentication = yield* Authentication.Service;
		const viewer = yield* DesktopViewer.Service;
		const trusted = new Set((yield* Installation.Service).trustedOrigins);

		yield* router.add(
			"GET",
			`${API_BASE_PATH}/threads/:threadId/agents/:agentId/desktop`,
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				// Any page the browser visits can open a WebSocket here with the
				// person's cookie, so only the web app's own origin may.
				if (!request.headers.origin || !trusted.has(request.headers.origin)) {
					return HttpServerResponse.text("Untrusted origin", { status: 403 });
				}
				const holder = yield* authentication.identify(new Headers(request.headers));
				if (!holder) return HttpServerResponse.text("Sign in first", { status: 401 });
				const { threadId, agentId } = yield* HttpRouter.params;
				if (!threadId || !agentId) return HttpServerResponse.empty({ status: 404 });

				return yield* Effect.scoped(
					Effect.gen(function* () {
						const desktop = yield* viewer.open({ threadId, agentId });
						const browserSide = yield* request.upgrade;
						yield* relay(browserSide, upstream(desktop));
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
					Effect.logWarning("The desktop viewer's connection ended badly", cause).pipe(
						Effect.as(HttpServerResponse.empty({ status: 502 })),
					),
				),
			),
		);
	}),
);

/**
 * The desktop's VNC server as a WebSocket, which x11vnc accepts on its VNC
 * port, reached through the sandbox provider.
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

/** Copies frames each way until either side closes. */
function relay(browserSide: Socket.Socket, desktopSide: Effect.Effect<Socket.Socket>) {
	return Effect.scoped(
		Effect.gen(function* () {
			const desktop = yield* desktopSide;
			const [fromBrowser, fromDesktop] = yield* Effect.all([browserSide.reader, desktop.reader]);
			const [toBrowser, toDesktop] = yield* Effect.all([browserSide.writer, desktop.writer]);
			const pump = (from: Socket.Reader, to: Socket.Writer) =>
				from.pull.pipe(
					Effect.flatMap((frames) =>
						Effect.forEach(frames, (frame) => to.write(frame), { discard: true }),
					),
					Effect.forever,
				);
			return yield* Effect.raceFirst(pump(fromBrowser, toDesktop), pump(fromDesktop, toBrowser));
		}),
	).pipe(Effect.ignore);
}

/** Asks x11vnc for VNC's bytes as they are rather than as base64 text. */
const VNC_SUBPROTOCOL = "binary";

/** Any origin satisfies x11vnc, which only checks that one is given. */
const RELAY_ORIGIN = "http://sugabots-desktop-relay";
