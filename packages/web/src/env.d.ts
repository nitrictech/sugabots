/// <reference types="vite/client" />

/** When this build was made, which is how a saved query cache knows it is from another. */
declare const __BUILD_ID__: string;

/** Build-time configuration. Vite inlines these; nothing secret goes here. */
interface ImportMetaEnv {
	/** Where the API is, path included. Unset, `/api` of the page's own origin. */
	readonly VITE_API_URL?: string;
}
