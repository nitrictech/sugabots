/// <reference types="vite/client" />

/** Build-time configuration. Vite inlines these; nothing secret goes here. */
interface ImportMetaEnv {
	/** `"true"` once the repo and docs are public. See `launched` in site-links.ts. */
	readonly VITE_LAUNCHED?: string;
}
