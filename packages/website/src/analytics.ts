import posthog from "posthog-js";

const posthogKey = import.meta.env.VITE_POSTHOG_KEY ?? "";

/** Suga's proxy for PostHog US, which ad blockers don't list the way they list PostHog's hosts. */
const POSTHOG_PROXY_URL = "https://p.suga.app";
/** Where PostHog's toolbar and links from events lead, since the proxy only takes events. */
const POSTHOG_APP_URL = "https://us.posthog.com";

/**
 * Starts PostHog in the browser, in a production build with a PostHog key.
 * It sets no cookies and stores nothing in the browser, so visitors aren't
 * asked for consent; PostHog counts them with a hash on its servers instead.
 * That rules out session replay, which needs browser storage.
 */
export function startAnalytics() {
	if (!import.meta.env.PROD || posthogKey === "" || posthog.__loaded) return;
	posthog.init(posthogKey, {
		api_host: POSTHOG_PROXY_URL,
		ui_host: POSTHOG_APP_URL,
		defaults: "2026-08-30",
		cookieless_mode: "always",
		// A lasting identity would undo the privacy cookieless mode gives visitors.
		person_profiles: "never",
	});
}

/** A call to action whose clicks are counted. */
export type CallToAction = "get_started" | "docs" | "github" | "discord";

/** Where on the site a call to action sits. */
export type CallToActionPlacement =
	| "header"
	| "hero"
	| "get_started_section"
	| "footer"
	| "docs_header";

/** Counts a click on a call to action, when analytics is running. */
export function trackCallToActionClick(cta: CallToAction, placement: CallToActionPlacement) {
	if (!posthog.__loaded) return;
	posthog.capture("website:cta_clicked", { cta, placement });
}

/** Counts a press of play on the landing page's film, when analytics is running. */
export function trackVideoPlay() {
	if (!posthog.__loaded) return;
	posthog.capture("website:video_played");
}
