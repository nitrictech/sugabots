/// <reference types="vite/client" />

/** Build-time configuration. Vite inlines these; nothing secret goes here. */
interface ImportMetaEnv {
	/** PostHog's project key, which is public. Production builds with it send analytics. */
	readonly VITE_POSTHOG_KEY?: string;
}
