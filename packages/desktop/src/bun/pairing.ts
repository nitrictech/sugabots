import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
	DEVICE_PAIRING_PAGE,
	DEVICE_PAIRINGS_PATH,
	devicePairingCodeSchema,
} from "@sugabots/contracts/devices";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Schema } from "effect";

export type PairingStarted =
	| { readonly ok: true; readonly token: string; readonly approvalUrl: string }
	| { readonly ok: false; readonly message: string };

const decodeCode = Schema.decodeUnknownOption(devicePairingCodeSchema);

/**
 * Asks `server` to pair this computer under a new token. The server is only
 * sent the token's SHA-256, so whoever approves the code pairs exactly the
 * computer that holds the token. Approval happens at `approvalUrl`, in the
 * web app, by somebody signed in.
 */
export async function startPairing(server: string): Promise<PairingStarted> {
	const token = randomBytes(32).toString("base64url");
	let body: unknown;
	try {
		const response = await fetch(`${server}${API_BASE_PATH}${DEVICE_PAIRINGS_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: hostname(),
				tokenDigest: createHash("sha256").update(token).digest("hex"),
			}),
		});
		body = response.ok ? await response.json() : undefined;
	} catch {
		return { ok: false, message: "Couldn't reach the server to pair this computer." };
	}
	const pairing = decodeCode(body);
	if (pairing._tag === "None") {
		return { ok: false, message: "The server didn't accept the pairing request." };
	}
	const approvalUrl = new URL(DEVICE_PAIRING_PAGE, server);
	approvalUrl.searchParams.set("code", pairing.value.code);
	return { ok: true, token, approvalUrl: approvalUrl.href };
}
