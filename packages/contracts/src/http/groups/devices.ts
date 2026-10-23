import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	DEVICE_PAIRINGS_PATH,
	devicePairingCodeSchema,
	devicePairingRequestSchema,
	deviceSchema,
	lendRequestSchema,
	localAgentSchema,
	pendingDevicePairingSchema,
	stopLendingRequestSchema,
} from "../../devices.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict, NotFound } from "../errors.ts";
import { Session } from "../middleware.ts";

/**
 * The signed-in person's devices: approving one's pairing, listing them,
 * asking one to lend or stop lending an agent, and forgetting one.
 */
export class DevicesApi extends HttpApiGroup.make("devices")
	.add(
		HttpApiEndpoint.get("list", "/devices", { success: Schema.Array(deviceSchema) }),
		HttpApiEndpoint.get("pendingPairing", `${DEVICE_PAIRINGS_PATH}/:code`, {
			params: { code: Schema.String },
			success: pendingDevicePairingSchema,
			error: [NotFound],
		}),
		HttpApiEndpoint.post("approvePairing", `${DEVICE_PAIRINGS_PATH}/:code/approve`, {
			params: { code: Schema.String },
			success: deviceSchema,
			error: [NotFound],
		}),
		// Waits while the device's owner chooses a folder on it: Conflict when they decline.
		HttpApiEndpoint.post("lend", "/devices/:deviceId/agents", {
			params: { deviceId: uuidSchema },
			payload: lendRequestSchema,
			success: localAgentSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict, NotFound],
		}),
		HttpApiEndpoint.post("stopLending", "/devices/:deviceId/agents/remove", {
			params: { deviceId: uuidSchema },
			payload: stopLendingRequestSchema,
			success: HttpApiSchema.Empty(204),
			error: [BadRequest, NotFound],
		}),
		HttpApiEndpoint.delete("forget", "/devices/:deviceId", {
			params: { deviceId: uuidSchema },
			success: HttpApiSchema.Empty(204),
			error: [NotFound],
		}),
	)
	.middleware(Session) {}

/**
 * Where a desktop asks to be paired. Without a session: the request only
 * names a code, which does nothing until a signed-in person approves it.
 */
export class DevicePairingRequestsApi extends HttpApiGroup.make("devicePairingRequests").add(
	HttpApiEndpoint.post("request", DEVICE_PAIRINGS_PATH, {
		payload: devicePairingRequestSchema,
		success: devicePairingCodeSchema.pipe(HttpApiSchema.status(201)),
		error: [BadRequest],
	}),
) {}
