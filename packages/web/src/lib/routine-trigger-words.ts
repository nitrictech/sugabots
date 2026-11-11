import type {
	ConnectionKind,
	RepositoryEvent,
	RoutineTrigger,
	WebhookAuthKind,
	WebhookHmacAlgorithm,
	WebhookSignatureEncoding,
	WebhookSource,
} from "@sugabots/contracts";

/*
 * What a routine's triggers are called where they are set up: the kinds of
 * trigger, a webhook's senders and how it checks them, and the events at a
 * repository. Plain data, which the native apps' copies are generated from.
 * apps/codegen loads this module with Node, so it imports nothing but types.
 */

export type TriggerKind = RoutineTrigger["kind"];

export interface TriggerKindChoice {
	readonly kind: TriggerKind;
	readonly label: string;
	readonly sub: string;
	/** The kind of connection the bot's pod needs for it, for an integration's trigger. */
	readonly connection?: ConnectionKind;
}

/** Every kind of trigger, Sugabots' own first, in the order the dialog lists them. */
export const TRIGGER_KINDS: readonly TriggerKindChoice[] = [
	{ kind: "cron", label: "Schedule", sub: "On the days and at the times you pick" },
	{ kind: "webhook", label: "Webhook", sub: "When something calls its address" },
	{
		kind: "github",
		label: "GitHub",
		sub: "When something happens on a repository: pull requests, issues, checks, pushes",
		connection: "github",
	},
];

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

/** What a caller must do to be let in, for each source, in the note under the webhook's rows. */
export const WEBHOOK_SOURCE_NOTES: Record<WebhookSource, string> = {
	github:
		"Add the address as a webhook in GitHub, with the content type application/json, and give it the same secret.",
	stripe: "Add the address as an endpoint in Stripe, and paste its signing secret.",
	slack: "Set the address as your Slack app's Request URL, and paste its Signing Secret.",
	linear: "Add the address as a webhook in Linear, and paste its signing secret.",
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
