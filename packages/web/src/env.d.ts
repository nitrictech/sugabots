/// <reference types="vite/client" />

/** Build-time configuration. Vite inlines these; nothing secret goes here. */
interface ImportMetaEnv {
	/** Where the API is, path included. Unset, `/api` of the page's own origin. */
	readonly VITE_API_URL?: string;
}
