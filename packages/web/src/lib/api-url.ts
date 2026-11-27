import { API_BASE_PATH } from "@sugabots/contracts/http";

/**
 * Where the API is, path included: `VITE_API_URL` when set, otherwise
 * `API_BASE_PATH`, either one read against the origin this page was served
 * from, so `/api` works as well as a whole address. Addresses built from it
 * are whole, ready to copy or to open a socket to.
 */
export const apiBaseUrl = new URL(
	import.meta.env.VITE_API_URL ?? API_BASE_PATH,
	window.location.origin,
).href.replace(/\/+$/, "");
