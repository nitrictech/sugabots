import { API_BASE_PATH } from "@sugabots/contracts/http";

/**
 * Where the API is, path included: `VITE_API_URL` when set, otherwise
 * `API_BASE_PATH` of the origin this page was served from.
 */
export const apiBaseUrl = (
	import.meta.env.VITE_API_URL ?? `${window.location.origin}${API_BASE_PATH}`
).replace(/\/+$/, "");
