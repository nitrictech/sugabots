/**
 * Where the API is, path included: `VITE_API_URL` when set, otherwise `/api`
 * of the origin this page was served from.
 */
export const apiBaseUrl = (import.meta.env.VITE_API_URL ?? `${window.location.origin}/api`).replace(
	/\/+$/,
	"",
);
