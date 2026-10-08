import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { WebhookAuth, WebhookAuthKind } from "@sugabots/contracts";

/** A request to a webhook routine's address, as it arrived. */
export interface Delivery {
	/** By lower-case name. */
	readonly headers: Readonly<Record<string, string | undefined>>;
	/** The body's bytes, exactly as sent, since a signature is over them. */
	readonly body: Uint8Array;
	readonly payload: unknown;
}

/**
 * How far a signed timestamp may be from now, either way, before the delivery
 * is refused as a replay: the five minutes Slack and Stripe recommend.
 */
const SIGNED_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/** Marks each kind's secrets, so people can tell them apart; Basic's password has none. */
const SECRET_PREFIXES: Record<WebhookAuthKind, string> = {
	hmac: "whsec_",
	api_key: "sk_rt_",
	bearer: "rtb_",
	basic: "",
};

/** The headers callers name a delivery by, so a retry lands on the first delivery's run. */
const DELIVERY_ID_HEADERS = [
	"idempotency-key",
	"linear-delivery",
	"x-github-delivery",
	"x-shopify-webhook-id",
	"webhook-id",
];

export function generateSecret(kind: WebhookAuthKind): string {
	return `${SECRET_PREFIXES[kind]}${randomBytes(32).toString("base64url")}`;
}

/**
 * Whether `delivery` proves it holds `secret` the way `auth` says, at `now`.
 * A sent secret is compared in constant time; a signature is checked over
 * the raw body.
 */
export function deliveryAuthentic(
	auth: WebhookAuth,
	secret: string,
	delivery: Delivery,
	now: Date,
): boolean {
	if (auth.kind !== "hmac") {
		const presented = presentedSecret(auth, delivery.headers);
		return presented !== undefined && sameSecret(presented, secret);
	}
	switch (auth.format) {
		case "body":
			return bodySignatureValid(
				auth.algorithm,
				delivery.headers[auth.header.toLowerCase()],
				secret,
				delivery.body,
			);
		case "slack":
			return slackSignatureValid(delivery, secret, now);
		case "stripe":
			return stripeSignatureValid(delivery, secret, now);
	}
}

/**
 * The secret the caller sent in the place `auth` names, for the kinds that
 * send one rather than signing.
 */
export function presentedSecret(
	auth: Exclude<WebhookAuth, { kind: "hmac" }>,
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

/**
 * What the delivery calls itself, if anything: Slack and Stripe name their
 * events in the body, and other callers in a header.
 */
export function deliveryIdOf(auth: WebhookAuth, delivery: Delivery): string | null {
	if (auth.kind === "hmac" && auth.format === "slack")
		return bodyString(delivery.payload, "event_id");
	if (auth.kind === "hmac" && auth.format === "stripe") return bodyString(delivery.payload, "id");
	for (const header of DELIVERY_ID_HEADERS) {
		const value = nonEmpty(delivery.headers[header]?.trim());
		if (value) return value;
	}
	return null;
}

/**
 * The challenge in Slack's check that the address answers to it, which Slack
 * sends, signed, before any event.
 */
export function slackChallengeOf(auth: WebhookAuth, payload: unknown): string | undefined {
	if (auth.kind !== "hmac" || auth.format !== "slack") return undefined;
	if (bodyString(payload, "type") !== "url_verification") return undefined;
	return bodyString(payload, "challenge") ?? undefined;
}

/**
 * The signature of `body` is hex or base64, optionally after the algorithm's
 * name (`sha256=`), so Linear's bare hex, GitHub's prefixed hex and Shopify's
 * base64 all verify.
 */
function bodySignatureValid(
	algorithm: "sha256" | "sha512",
	header: string | undefined,
	secret: string,
	body: Uint8Array,
): boolean {
	const sent = header?.trim().replace(new RegExp(`^${algorithm}=`, "i"), "");
	if (!sent) return false;
	const expected = createHmac(algorithm, secret).update(body).digest();
	return signatureMatches(sent, expected);
}

/** Slack signs `v0:{timestamp}:{body}` and sends `v0={hex}`. */
function slackSignatureValid(delivery: Delivery, secret: string, now: Date): boolean {
	const timestamp = delivery.headers["x-slack-request-timestamp"]?.trim();
	const sent = /^v0=([0-9a-f]+)$/i.exec(delivery.headers["x-slack-signature"]?.trim() ?? "")?.[1];
	if (!timestamp || !sent || !timestampFresh(timestamp, now)) return false;
	const expected = createHmac("sha256", secret)
		.update(`v0:${timestamp}:`)
		.update(delivery.body)
		.digest();
	return signatureMatches(sent, expected);
}

/**
 * Stripe signs `{t}.{body}` and sends `t={t},v1={hex}`, with a `v1` for each
 * secret it is signing with while one is being rolled.
 */
function stripeSignatureValid(delivery: Delivery, secret: string, now: Date): boolean {
	const fields = (delivery.headers["stripe-signature"] ?? "").split(",").map((field) => {
		const equals = field.indexOf("=");
		return [field.slice(0, equals).trim(), field.slice(equals + 1).trim()] as const;
	});
	const timestamp = fields.find(([key]) => key === "t")?.[1];
	if (!timestamp || !timestampFresh(timestamp, now)) return false;
	const expected = createHmac("sha256", secret)
		.update(`${timestamp}.`)
		.update(delivery.body)
		.digest();
	return fields.some(([key, value]) => key === "v1" && signatureMatches(value, expected));
}

/** Whether `timestamp`, in seconds since the epoch, is within the tolerance of `now`. */
function timestampFresh(timestamp: string, now: Date): boolean {
	if (!/^\d+$/.test(timestamp)) return false;
	const ageSeconds = Math.abs(now.getTime() / 1000 - Number(timestamp));
	return ageSeconds <= SIGNED_TIMESTAMP_TOLERANCE_SECONDS;
}

function signatureMatches(sent: string, expected: Buffer): boolean {
	const decoded = /^[0-9a-f]+$/i.test(sent)
		? Buffer.from(sent, "hex")
		: Buffer.from(sent, "base64");
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

function nonEmpty(value: string | undefined): string | undefined {
	return value === "" ? undefined : value;
}
