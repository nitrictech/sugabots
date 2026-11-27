import { API_BASE_PATH } from "@sugabots/contracts/http";
import { computersContracts } from "@sugabots/contracts/operations/computers";
import { SessionAuthentication } from "@sugabots/core/authentication/session";
import {
	answerChallenge,
	CHALLENGE_BYTES,
} from "@sugabots/core/chats/tools/browser/vnc-authentication";
import type { Computers } from "@sugabots/core/computers/computers";
import { Ids } from "@sugabots/core/ids/ids";
import { Operations } from "@sugabots/core/operations/registry";
import { Egress } from "@sugabots/core/providers/network/egress";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { processLayer } from "@sugabots/core/tiers";
import { type DomainError, userText } from "@sugabots/errors";
import { Context, Duration, Effect, ErrorReporter, Layer, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";
import { Authentication } from "../auth/authentication.ts";

/**
 * A bot's desktop in a chat, live: a WebSocket the web app's noVNC
 * viewer opens, relayed to the desktop's VNC server in the computer. The relay
 * logs in to the server with its password and offers the viewer no
 * authentication, then passes frames both ways untouched; neither the
 * password nor the computer's address reaches the browser.
 *
 * The desktop viewer is a long-running operation, `computers.viewDesktop`,
 * authenticated from the session's row: it proves again whenever who reaches
 * what changes, and the relay closes once it ends, because the member may no
 * longer see the desktop as it was opened for them, or their session ended
 * or expired. It closes after {@link DesktopViewerTiming}'s `maxAge` too, as
 * an event stream does, so a viewer that went away without its socket
 * noticing holds no computer awake for long.
 */
export const desktopViewerRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const { maxAge } = yield* DesktopViewerTiming;
		const router = yield* HttpRouter.HttpRouter;
		const authentication = yield* Authentication.Service;
		const sessions = yield* SessionAuthentication.Service;
		const operations = yield* Operations.LongRunning;
		const ids = yield* Ids.Service;
		const egress = yield* Egress.Service;
		const trusted = new Set((yield* ServerSettings.Service).trustedOrigins);
		const decodeAddress = Schema.decodeSync(computersContracts["computers.viewDesktop"].input);

		yield* router.add(
			"GET",
			`${API_BASE_PATH}/chats/:chatId/bots/:botId/desktop`,
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				// Any page the browser visits can open a WebSocket here with the
				// member's cookie, so only the web app's own origin may.
				if (!request.headers.origin || !trusted.has(request.headers.origin)) {
					return HttpServerResponse.text("Untrusted origin", { status: 403 });
				}
				const headers = new Headers(request.headers);
				const holder = yield* authentication.identify(headers);
				const principal = yield* sessions.authenticateLongRunning(headers).pipe(
					Effect.provideService(SessionAuthentication.Cookies, {
						read: () =>
							Effect.succeed(holder && { session: holder.session, member: holder.member.id }),
					}),
					Effect.option,
				);
				if (principal._tag === "None") {
					return HttpServerResponse.text("Sign in first", { status: 401 });
				}
				const { chatId, botId } = yield* HttpRouter.params;
				if (!chatId || !botId) return HttpServerResponse.empty({ status: 404 });
				const call = { kind: "request" as const, request: yield* ids.next };

				return yield* Effect.scoped(
					Effect.gen(function* () {
						const viewing = yield* operations["computers.viewDesktop"](
							principal.value,
							decodeAddress({ chatId, botId }),
							call,
						);
						const [desktop] = yield* Stream.runCollect(Stream.take(viewing.stream, 1));
						if (!desktop) return HttpServerResponse.empty({ status: 404 });
						const browserSide = yield* request.upgrade;
						// Ending the relay closes the member's socket; the operation ending, or its
						// time running out, ends the relay.
						yield* Effect.raceAll([
							relay(browserSide, upstream(desktop.endpoint, egress), desktop.password),
							viewing.ended,
							Effect.sleep(maxAge),
						]);
						return HttpServerResponse.empty();
					}),
				).pipe(
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
).pipe(processLayer);

/** How long a desktop viewer stays open, which a test may shorten. */
interface DesktopViewerTimingInterface {
	/**
	 * After this the viewer closes, and opening it again proves afresh.
	 * Bounds what a viewer that went away without its socket noticing holds
	 * open, and how long a desktop stays open on proofs that might be stale.
	 */
	readonly maxAge: Duration.Input;
}

export const DesktopViewerTiming = Context.Reference<DesktopViewerTimingInterface>(
	"@sugabots/server/DesktopViewerTiming",
	{ defaultValue: () => ({ maxAge: Duration.minutes(30) }) },
);

/**
 * The desktop's VNC server as a WebSocket, reached through the computer
 * provider: websockify in front of Xvnc.
 */
function upstream(desktop: Pick<Computers.Endpoint, "url" | "headers">, egress: Egress.Interface) {
	return Socket.fromWebSocket(
		egress.providerWebSocket(desktop.url, [VNC_SUBPROTOCOL], desktop.headers).pipe(
			Effect.mapError(
				(cause) =>
					new Socket.SocketError({
						reason: new Socket.SocketOpenError({ kind: "Unknown", cause }),
					}),
			),
		),
		{ openTimeout: "10 seconds" },
	);
}

/**
 * Signs in to the desktop for the member, then copies frames each way until
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
			yield* signIn({ browser, toBrowser, desktop, toDesktop, password });
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
		Effect.catchTag("DesktopSignInFailed", (failure) =>
			Effect.logWarning(`Couldn't sign in to the desktop for its viewer: ${failure.reason}`),
		),
		Effect.ignore,
	);
}

/**
 * The start of RFB 3.8 (RFC 6143, 7.1-7.1.3) between the two sides: the
 * relay answers the desktop's VNC authentication, and tells the viewer it
 * needs none.
 */
function signIn({
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
			return yield* new DesktopSignInFailed({ reason: "the viewer doesn't speak RFB 3.8" });
		}
		yield* toDesktop.write(viewerVersion);
		const [offered = 0] = yield* desktop.take(1);
		const securityTypes = yield* desktop.take(offered);
		if (!securityTypes.includes(VNC_AUTHENTICATION)) {
			return yield* new DesktopSignInFailed({ reason: "the desktop doesn't ask for a password" });
		}
		yield* toBrowser.write(Uint8Array.of(1, NO_AUTHENTICATION));
		const [chosen] = yield* browser.take(1);
		if (chosen !== NO_AUTHENTICATION) {
			return yield* new DesktopSignInFailed({ reason: "the viewer chose another security type" });
		}
		yield* toDesktop.write(Uint8Array.of(VNC_AUTHENTICATION));
		const challenge = yield* desktop.take(CHALLENGE_BYTES);
		yield* toDesktop.write(answerChallenge(password, challenge));
		const result = yield* desktop.take(SECURITY_RESULT_BYTES);
		if (result.some((byte) => byte !== 0)) {
			return yield* new DesktopSignInFailed({ reason: "the desktop refused its password" });
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
class DesktopSignInFailed
	extends Schema.TaggedError<DesktopSignInFailed>()("DesktopSignInFailed", {
		reason: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return this.reason;
	}
	get userMessage() {
		return userText`Sugabots couldn't connect to the desktop. Close the viewer and open it again.`;
	}
}

const RFB_3_8 = "RFB 003.008\n";
const VERSION_BYTES = RFB_3_8.length;
const NO_AUTHENTICATION = 1;
const VNC_AUTHENTICATION = 2;
const SECURITY_RESULT_BYTES = 4;

/** Asks for VNC's bytes as they are rather than as base64 text. */
const VNC_SUBPROTOCOL = "binary";
