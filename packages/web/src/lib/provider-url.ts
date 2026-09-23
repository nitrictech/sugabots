import { OPENAI_COMPATIBLE_PATH, providerUrlSchema } from "@sugabots/contracts";
import { Option, Schema } from "effect";

/**
 * The base URL somebody typed, or nothing if what they typed is not one. A bare
 * host is completed: `http://` in front, since a provider you run yourself is
 * usually plain HTTP, and the path an OpenAI-compatible server answers on.
 *
 * A form has no other way to turn typed text into a base URL, so it cannot
 * submit something the API will refuse on shape alone, and cannot hold an
 * opinion about what a base URL is that differs from the API's.
 */
export function parseProviderBaseUrl(typed: string): string | undefined {
	const trimmed = typed.trim();
	if (!trimmed) return undefined;
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
	} catch {
		return undefined;
	}
	if (url.pathname === "/") url.pathname = OPENAI_COMPATIBLE_PATH;
	const baseUrl = url.toString().replace(/\/$/, "");
	return Option.getOrUndefined(Schema.decodeUnknownOption(providerUrlSchema)(baseUrl));
}
