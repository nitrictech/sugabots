import { Conflict, NotFound } from "@sugabots/contracts/http";
import { Devices } from "@sugabots/core/devices/devices";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError } from "../../http/errors.ts";

/** The signed-in person's devices: approving one's pairing, listing them, lending from one, and forgetting one. */
export const deviceRoutes = HttpApiBuilder.group(ServerApi, "devices", (handlers) =>
	Effect.gen(function* () {
		const devices = yield* Devices.Service;
		return handlers
			.handle("list", () => devices.list.pipe(asSessionUser))
			.handle("pendingPairing", ({ params }) =>
				devices.pendingPairing(params.code).pipe(asSessionUser, asHttpError(deviceErrors)),
			)
			.handle("approvePairing", ({ params }) =>
				devices.approvePairing(params.code).pipe(asSessionUser, asHttpError(deviceErrors)),
			)
			.handle("lend", ({ params, payload }) =>
				devices.lend(params.deviceId, payload.kind).pipe(asSessionUser, asHttpError(deviceErrors)),
			)
			.handle("stopLending", ({ params, payload }) =>
				devices
					.stopLending(params.deviceId, payload.url)
					.pipe(asSessionUser, asHttpError(deviceErrors)),
			)
			.handle("forget", ({ params }) =>
				devices.forget(params.deviceId).pipe(asSessionUser, asHttpError(deviceErrors)),
			);
	}),
);

/** Where a desktop asks to be paired, without a session. */
export const devicePairingRequestRoutes = HttpApiBuilder.group(
	ServerApi,
	"devicePairingRequests",
	(handlers) =>
		Effect.gen(function* () {
			const devices = yield* Devices.Service;
			return handlers.handle("request", ({ payload }) => devices.requestPairing(payload));
		}),
);

const deviceErrors = {
	DevicePairingNotFound: NotFound,
	DeviceNotFound: NotFound,
	DeviceOffline: NotFound,
	LendingDeclined: Conflict,
};
