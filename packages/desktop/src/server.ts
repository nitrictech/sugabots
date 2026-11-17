import { healthResponseSchema } from "@sugabots/contracts/api";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Schema } from "effect";
import { net } from "electron";

/** How long a server has to answer before the app says it can't be reached. */
const SERVER_CHECK_TIMEOUT_MS = 10_000;

export type FoundServer =
	| { readonly ok: true; readonly origin: string }
	| { readonly ok: false; readonly message: string };

const isHealthResponse = Schema.is(healthResponseSchema);

/**
 * The origin of the Sugabots server a person typed, once its health endpoint
 * answers. An address without a scheme is taken to be HTTPS, and any path is dropped.
 */
export async function findServer(address: string): Promise<FoundServer> {
	const url = parseAddress(address);
	if (!url) {
		return { ok: false, message: "Enter a server address, such as sugabots.example.com." };
	}

	let body: unknown;
	try {
		// Chromium's network stack rather than Node's, so the check trusts the same
		// certificates and proxies as the window that will open the server.
		const response = await net.fetch(`${url.origin}${API_BASE_PATH}/health`, {
			signal: AbortSignal.timeout(SERVER_CHECK_TIMEOUT_MS),
		});
		body = response.ok ? await response.json() : undefined;
	} catch {
		return {
			ok: false,
			message: `Couldn't reach ${url.host}. Check the address and your connection.`,
		};
	}
	if (!isHealthResponse(body)) {
		return { ok: false, message: `${url.host} answered, but it isn't a Sugabots server.` };
	}
	return { ok: true, origin: url.origin };
}

function parseAddress(address: string): URL | undefined {
	const trimmed = address.trim();
	if (trimmed === "") return undefined;
	const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	const url = URL.parse(withScheme);
	return url && (url.protocol === "https:" || url.protocol === "http:") ? url : undefined;
}
