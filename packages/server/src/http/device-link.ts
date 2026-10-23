import { DEVICE_LINK_PATH } from "@sugabots/contracts";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { DeviceLinks } from "@sugabots/core/devices/device-links";
import { Devices } from "@sugabots/core/devices/devices";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

/**
 * The WebSocket a paired desktop dials out on, with its device token as a
 * bearer token, and keeps open. Requests to the agents it lends go down it.
 * No browser opens it: a page can't set the Authorization header on a
 * WebSocket, so the token is what admits it, not a cookie or an origin.
 */
export const deviceLinkRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const devices = yield* Devices.Service;
		const links = yield* DeviceLinks.Service;

		yield* router.add(
			"GET",
			`${API_BASE_PATH}${DEVICE_LINK_PATH}`,
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
				const device = token === undefined ? undefined : yield* devices.authenticate(token);
				if (!device) return HttpServerResponse.text("Pair this device first", { status: 401 });
				const socket = yield* request.upgrade;
				yield* Effect.log(`Device ${device.id} connected`);
				yield* links.serve(device.id, socket);
				yield* Effect.log(`Device ${device.id} disconnected`);
				return HttpServerResponse.empty();
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("A device's link ended badly", cause).pipe(
						Effect.as(HttpServerResponse.empty({ status: 502 })),
					),
				),
			),
		);
	}),
);
