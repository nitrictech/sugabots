import { DEVICE_CONNECT_PATH, type DeviceFrame } from "@sugabots/contracts/devices";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { Visibility } from "@sugabots/core/authorization/visibility";
import { Devices } from "@sugabots/core/devices/devices";
import { Installation } from "@sugabots/core/installation/installation";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Authentication } from "../auth/authentication.ts";

/**
 * The desktop app's socket, and lending a person's desktop to a thread. A
 * spike: the app signs in with the session cookie its window holds, where a
 * real version would pair the device and give it a token of its own.
 */
export const deviceRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const authentication = yield* Authentication.Service;
		const devices = yield* Devices.Service;
		const visibility = yield* Visibility.Service;
		const trusted = new Set((yield* Installation.Service).trustedOrigins);

		const signedIn = Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const holder = yield* authentication.identify(new Headers(request.headers));
			return holder?.user.id;
		});

		yield* router.add(
			"GET",
			`${API_BASE_PATH}${DEVICE_CONNECT_PATH}`,
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				// Any page the browser visits can open a WebSocket here with the
				// person's cookie, so only the app's own origin may.
				if (!request.headers.origin || !trusted.has(request.headers.origin)) {
					return HttpServerResponse.text("Untrusted origin", { status: 403 });
				}
				const ownerId = yield* signedIn;
				if (!ownerId) return HttpServerResponse.text("Sign in first", { status: 401 });
				const name = new URL(request.url, "http://device").searchParams.get("name") ?? "Desktop";

				return yield* Effect.scoped(
					Effect.gen(function* () {
						const socket = yield* request.upgrade;
						const writer = yield* socket.writer;
						const runFork = Effect.runForkWith(yield* Effect.context<never>());
						const reader = yield* socket.reader;
						const connected = yield* Effect.acquireRelease(
							devices.connect({
								ownerId,
								name,
								send: (frame) => runFork(writer.write(JSON.stringify(frame))),
							}),
							(device) => Effect.sync(() => device.disconnect()),
						);
						yield* Effect.logInfo(`${name} connected for ${ownerId}`);
						const decoder = new TextDecoder();
						return yield* reader.pull.pipe(
							Effect.flatMap((frames) =>
								Effect.sync(() => {
									for (const frame of frames) {
										const text = typeof frame === "string" ? frame : decoder.decode(frame);
										connected.receive(JSON.parse(text) as DeviceFrame);
									}
								}),
							),
							Effect.forever,
						);
					}),
				);
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.logInfo("A device's connection ended", cause).pipe(
						Effect.as(HttpServerResponse.empty()),
					),
				),
			),
		);

		const myDevice = (lend?: (threadId: string, ownerId: string) => Effect.Effect<void>) =>
			Effect.gen(function* () {
				const ownerId = yield* signedIn;
				if (!ownerId) return HttpServerResponse.text("Sign in first", { status: 401 });
				const { threadId } = yield* HttpRouter.params;
				if (!threadId) return HttpServerResponse.empty({ status: 404 });
				return yield* Effect.gen(function* () {
					// Only someone who can see the thread may lend it a device.
					yield* visibility.thread(threadId);
					if (lend) yield* lend(threadId, ownerId);
					return yield* HttpServerResponse.json(yield* devices.lending(threadId, ownerId));
				}).pipe(
					CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(ownerId)),
					Effect.catchTag("ResourceHidden", () =>
						Effect.succeed(HttpServerResponse.empty({ status: 404 })),
					),
				);
			}).pipe(Effect.orDie);

		yield* router.add("GET", `${API_BASE_PATH}/threads/:threadId/my-device`, myDevice());
		yield* router.add(
			"PUT",
			`${API_BASE_PATH}/threads/:threadId/my-device`,
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const body = yield* request.json.pipe(Effect.orElseSucceed(() => undefined));
				const lent = (body as { lent?: unknown } | undefined)?.lent;
				if (typeof lent !== "boolean")
					return HttpServerResponse.text("lent must be true or false", { status: 400 });
				return yield* myDevice((threadId, ownerId) => devices.lend(threadId, ownerId, lent));
			}),
		);
	}),
).pipe(Layer.provide(Visibility.layer));
