import type {
	RepositoryEvent,
	WebhookAuthKind,
	WebhookHmacAlgorithm,
	WebhookSignatureEncoding,
	WebhookSource,
} from "@sugabots/contracts";

/*
 * What a routine's triggers are called where they are set up: a webhook's
 * senders and how it checks them, and the events at a repository. Plain data,
 * which the native apps' copies are generated from.
 */

/** A way of checking a webhook's caller that isn't a known source's own signature. */
export type WebhookGenericKind = Exclude<WebhookAuthKind, WebhookSource>;

/** "generic" for any sender, else the source whose own way of signing is known. */
export type WebhookSourceChoice = "generic" | WebhookSource;

export const WEBHOOK_SOURCE_LABELS: Record<WebhookSourceChoice, string> = {
	generic: "Generic",
	github: "GitHub",
	stripe: "Stripe",
	slack: "Slack",
	linear: "Linear",
};

/** How each source's signing secret looks, as the placeholder for it. */
export const WEBHOOK_SOURCE_SECRET_PLACEHOLDERS: Record<WebhookSource, string> = {
	github: "The secret set on the webhook in GitHub",
	stripe: "whsec_…",
	slack: "The app's Signing Secret",
	linear: "lin_wh_…",
};

export const WEBHOOK_AUTH_OPTIONS = [
	{ value: "basic", label: "Basic" },
	{ value: "bearer", label: "Bearer" },
	{ value: "api_key", label: "API key" },
	{ value: "hmac", label: "HMAC" },
] as const satisfies readonly { value: WebhookGenericKind; label: string }[];

export const WEBHOOK_ALGORITHM_OPTIONS = [
	{ value: "sha1", label: "SHA-1" },
	{ value: "sha256", label: "SHA-256" },
	{ value: "sha512", label: "SHA-512" },
] as const satisfies readonly { value: WebhookHmacAlgorithm; label: string }[];

export const WEBHOOK_ENCODING_OPTIONS = [
	{ value: "hex", label: "Hex" },
	{ value: "base64", label: "Base64" },
] as const satisfies readonly { value: WebhookSignatureEncoding; label: string }[];

/** What each generic kind calls its secret; every source calls it a signing secret. */
export const WEBHOOK_SECRET_LABELS: Record<WebhookGenericKind, string> = {
	hmac: "Signing secret",
	api_key: "Key",
	bearer: "Token",
	basic: "Password",
};

/** Each repository event as its switch says it. */
export const REPOSITORY_EVENT_LABELS: Record<RepositoryEvent, string> = {
	pull_request_opened: "A pull request is opened",
	pull_request_review: "A pull request is reviewed",
	pull_request_comment: "Someone comments on a pull request",
	issue_opened: "An issue is opened",
	issue_comment: "Someone comments on an issue",
	checks_failed: "Checks fail",
	push: "A branch is pushed to",
};
