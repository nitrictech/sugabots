import { createClient } from "@sugabots/sdk";
import { apiBaseUrl } from "@/lib/api-url.ts";

/**
 * The one way this app talks to the API. Server types arrive through the SDK,
 * and the network is the only runtime coupling.
 *
 * Browser sessions use an HttpOnly cookie that JavaScript cannot read.
 */
export const client = createClient({ baseUrl: apiBaseUrl, authMode: "cookie" });
