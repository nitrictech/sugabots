import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	WEBHOOK_SECRET_PREFIXES,
	type WebhookAuth,
	type WebhookAuthKind,
	type WebhookHmacAlgorithm,
	type WebhookSignatureEncoding,
} from "@sugabots/contracts";

/** A request to a webhook routine's address, as it arrived. */
export interface Delivery {
	/** By lower-case name. */
	readonly headers: Readonly<Record<string, string | undefined>>;
	/** The body's bytes, exactly as sent, since a signature is over them. */
	readonly body: Uint8Array;
	readonly payload: unknown;
}

/** The kinds whose callers send the secret itself rather than signing with it. */
export type SentSecretAuth = Extract<WebhookAuth, { kind: "api_key" | "bearer" | "basic" }>;

/**
 * How far a signed timestamp may be from now, either way, before the delivery
 * is refused as a replay: the five minutes Slack and Stripe recommend.
 */
const SIGNED_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export function generateSecret(kind: WebhookAuthKind): string {
	return `${WEBHOOK_SECRET_PREFIXES[kind]}${randomBytes(32).toString("base64url")}`;
}

/**
 * Whether `delivery` proves it holds `secret` the way `auth` says, at `now`.
 * A sent secret is compared in constant time; a signature is checked over
 * the raw body, and a signed timestamp must be recent.
 */
export function deliveryAuthentic(
	auth: WebhookAuth,
	secret: string,
	delivery: Delivery,
	now: Date,
): boolean {
	const { headers, body } = delivery;
	switch (auth.kind) {
		case "api_key":
		case "bearer":
		case "basic": {
			const presented = presentedSecret(auth, headers);
			return presented !== undefined && sameSecret(presented, secret);
		}
		case "hmac": {
			const sent = headers[auth.header.toLowerCase()]
				?.trim()
				.replace(new RegExp(`^${auth.algorithm}=`, "i"), "");
			const expected = hmac(auth.algorithm, secret, body);
			return sent !== undefined && signatureMatches(sent, auth.encoding, expected);
		}
		// GitHub signs the body and sends `sha256={hex}`.
		case "github": {
			const sent = /^sha256=(.+)$/.exec(headers["x-hub-signature-256"]?.trim() ?? "")?.[1];
			return sent !== undefined && signatureMatches(sent, "hex", hmac("sha256", secret, body));
		}
		// Linear signs the body and sends the hex digest alone.
		case "linear": {
			const sent = headers["linear-signature"]?.trim();
			return sent !== undefined && signatureMatches(sent, "hex", hmac("sha256", secret, body));
		}
		// Slack signs `v0:{timestamp}:{body}` and sends `v0={hex}`.
		case "slack": {
			const timestamp = headers["x-slack-request-timestamp"]?.trim();
			const sent = /^v0=(.+)$/.exec(headers["x-slack-signature"]?.trim() ?? "")?.[1];
			if (!timestamp || !sent || !timestampFresh(timestamp, now)) return false;
			const expected = hmac("sha256", secret, body, `v0:${timestamp}:`);
			return signatureMatches(sent, "hex", expected);
		}
		// Stripe signs `{t}.{body}` and sends `t={t},v1={hex}`, with a `v1` for
		// each secret it signs with while one is being rolled.
		case "stripe": {
			const fields = keyedFields(headers["stripe-signature"] ?? "", ",", "=");
			const timestamp = fields.find(([key]) => key === "t")?.[1];
			if (!timestamp || !timestampFresh(timestamp, now)) return false;
			const expected = hmac("sha256", secret, body, `${timestamp}.`);
			return fields.some(([key, sent]) => key === "v1" && signatureMatches(sent, "hex", expected));
		}
	}
}

/** The secret the caller sent in the place `auth` names. */
export function presentedSecret(
	auth: SentSecretAuth,
	headers: Delivery["headers"],
): string | undefined {
	switch (auth.kind) {
		case "api_key":
			return nonEmpty(headers[auth.header.toLowerCase()]?.trim());
		case "bearer":
			return nonEmpty(/^Bearer +(.+)$/i.exec(headers.authorization?.trim() ?? "")?.[1]);
		case "basic": {
			const encoded = /^Basic +(\S+)$/i.exec(headers.authorization?.trim() ?? "")?.[1];
			if (!encoded) return undefined;
			const decoded = Buffer.from(encoded, "base64").toString("utf8");
			const colon = decoded.indexOf(":");
			if (colon < 0 || decoded.slice(0, colon) !== auth.username) return undefined;
			return nonEmpty(decoded.slice(colon + 1));
		}
	}
}

const AUTOMATIC_DELIVERY_ID_HEADERS = [
	"idempotency-key",
	"linear-delivery",
	"x-github-delivery",
	"x-shopify-webhook-id",
	"svix-id",
	"webhook-id",
];

/**
 * What the delivery calls itself, if anything, so a retry lands on the first
 * delivery's run. A known source names it its own way: GitHub's and Linear's
 * header, Slack's `event_id`, or the `id` of a Stripe event. Any other
 * sender's is in the header `deliveryIdHeader` names, with none to read when
 * that is null or the header is missing or empty. An undefined setting
 * preserves automatic header and body detection for existing triggers.
 */
export function deliveryIdOf(
	auth: WebhookAuth,
	deliveryIdHeader: string | null | undefined,
	{ headers, payload }: Delivery,
): string | null {
	if (deliveryIdHeader === undefined) {
		for (const header of AUTOMATIC_DELIVERY_ID_HEADERS) {
			if (auth.kind === "api_key" && header === auth.header.toLowerCase()) continue;
			const value = headerValue(headers, header);
			if (value) return value;
		}
		return (
			bodyString(payload, "event_id") ??
			(bodyString(payload, "object") === "event" ? bodyString(payload, "id") : null)
		);
	}
	switch (auth.kind) {
		case "github":
			return headerValue(headers, "x-github-delivery");
		case "linear":
			return headerValue(headers, "linear-delivery");
		case "slack":
			return bodyString(payload, "event_id");
		case "stripe":
			return bodyString(payload, "object") === "event" ? bodyString(payload, "id") : null;
		case "hmac":
		case "api_key":
		case "bearer":
		case "basic":
			return deliveryIdHeader === null ? null : headerValue(headers, deliveryIdHeader);
	}
}

/**
 * The challenge in Slack's check that the address answers to it, which Slack
 * sends, signed, before any event.
 */
export function slackChallengeOf(auth: WebhookAuth, payload: unknown): string | undefined {
	if (auth.kind !== "slack" || bodyString(payload, "type") !== "url_verification") {
		return undefined;
	}
	return bodyString(payload, "challenge") ?? undefined;
}

/** The HMAC of `signedBefore` then the body's bytes. */
function hmac(
	algorithm: WebhookHmacAlgorithm,
	key: string | Buffer,
	body: Uint8Array,
	signedBefore = "",
): Buffer {
	return createHmac(algorithm, key).update(signedBefore).update(body).digest();
}

/** `a=1,b=2` as `[["a", "1"], ["b", "2"]]`: split on `separator`, then at the first `assignment`. */
function keyedFields(value: string, separator: string, assignment: string): [string, string][] {
	return value
		.split(separator)
		.map((field) => field.trim())
		.filter((field) => field.includes(assignment))
		.map((field) => {
			const at = field.indexOf(assignment);
			return [field.slice(0, at), field.slice(at + 1)];
		});
}

/** Whether `timestamp`, in seconds since the epoch, is within the tolerance of `now`. */
function timestampFresh(timestamp: string, now: Date): boolean {
	if (!/^\d+$/.test(timestamp)) return false;
	const ageSeconds = Math.abs(now.getTime() / 1000 - Number(timestamp));
	return ageSeconds <= SIGNED_TIMESTAMP_TOLERANCE_SECONDS;
}

/** Whether `sent`, written in `encoding`, is `expected`, compared in constant time. */
function signatureMatches(
	sent: string,
	encoding: WebhookSignatureEncoding,
	expected: Buffer,
): boolean {
	const decoded = Buffer.from(sent, encoding);
	return decoded.length === expected.length && timingSafeEqual(decoded, expected);
}

/**
 * Compares digests rather than the secrets, so the comparison takes as long
 * whatever length the caller sent.
 */
function sameSecret(presented: string, secret: string): boolean {
	return timingSafeEqual(sha256(presented), sha256(secret));
}

function sha256(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

function bodyString(payload: unknown, field: string): string | null {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
	const value: unknown = Reflect.get(payload, field);
	return typeof value === "string" && value !== "" ? value : null;
}

/** The trimmed value of the header called `name` in any case, or null when it is missing or empty. */
function headerValue(headers: Delivery["headers"], name: string): string | null {
	return nonEmpty(headers[name.toLowerCase()]?.trim()) ?? null;
}

function nonEmpty(value: string | undefined): string | undefined {
	return value === "" ? undefined : value;
}
