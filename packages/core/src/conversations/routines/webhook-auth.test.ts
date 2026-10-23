import { createHmac } from "node:crypto";
import type { WebhookAuth } from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import {
	type Delivery,
	deliveryAuthentic,
	deliveryIdOf,
	generateSecret,
	slackChallengeOf,
} from "./webhook-auth.ts";

const SECRET = "lin_wh_0123456789abcdef";
const NOW = new Date("2026-10-08T00:00:00.000Z");
const NOW_SECONDS = NOW.getTime() / 1000;
const BODY = '{"action":"create", "data":{"id":"ISS-1"}}';

function delivery(headers: Record<string, string>, body = BODY): Delivery {
	return {
		headers: Object.fromEntries(
			Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
		),
		body: new TextEncoder().encode(body),
		payload: JSON.parse(body),
	};
}

function hmac(algorithm: "sha256" | "sha512", content: string, secret = SECRET) {
	return createHmac(algorithm, secret).update(content);
}

describe("secrets people send", () => {
	it.each<[string, WebhookAuth, Record<string, string>]>([
		["bearer", { kind: "bearer" }, { Authorization: `Bearer ${SECRET}` }],
		["API key", { kind: "api_key", header: "X-API-Key" }, { "X-API-Key": SECRET }],
		[
			"Basic",
			{ kind: "basic", username: "sugabots" },
			{ Authorization: `Basic ${Buffer.from(`sugabots:${SECRET}`).toString("base64")}` },
		],
	])("admits the %s secret", (_, auth, headers) => {
		expect(deliveryAuthentic(auth, SECRET, delivery(headers), NOW)).toBe(true);
	});

	it.each<[string, WebhookAuth, Record<string, string>]>([
		["a wrong bearer token", { kind: "bearer" }, { Authorization: "Bearer wrong" }],
		["no bearer token", { kind: "bearer" }, {}],
		["the key in another header", { kind: "api_key", header: "X-API-Key" }, { "X-Token": SECRET }],
		[
			"another username",
			{ kind: "basic", username: "sugabots" },
			{ Authorization: `Basic ${Buffer.from(`someone:${SECRET}`).toString("base64")}` },
		],
		[
			"the secret as a bearer token to Basic",
			{ kind: "basic", username: "sugabots" },
			{ Authorization: `Bearer ${SECRET}` },
		],
	])("refuses %s", (_, auth, headers) => {
		expect(deliveryAuthentic(auth, SECRET, delivery(headers), NOW)).toBe(false);
	});
});

describe("generic HMAC signatures", () => {
	const signed: WebhookAuth = {
		kind: "hmac",
		header: "X-Signature",
		algorithm: "sha256",
		encoding: "hex",
	};

	it("admits the hex digest of the body, bare or after its algorithm", () => {
		const signature = hmac("sha256", BODY).digest("hex");
		expect(deliveryAuthentic(signed, SECRET, delivery({ "X-Signature": signature }), NOW)).toBe(
			true,
		);
		expect(
			deliveryAuthentic(signed, SECRET, delivery({ "X-Signature": `sha256=${signature}` }), NOW),
		).toBe(true);
	});

	it("signs with the algorithm and encoding chosen", () => {
		const shopify: WebhookAuth = {
			kind: "hmac",
			header: "X-Shopify-Hmac-Sha256",
			algorithm: "sha512",
			encoding: "base64",
		};
		const signature = hmac("sha512", BODY).digest("base64");
		const sent = delivery({ "X-Shopify-Hmac-Sha256": signature });
		expect(deliveryAuthentic(shopify, SECRET, sent, NOW)).toBe(true);
		expect(deliveryAuthentic({ ...shopify, algorithm: "sha256" }, SECRET, sent, NOW)).toBe(false);
	});

	it("refuses a signature sent in another header", () => {
		const sent = delivery({ "X-Other": hmac("sha256", BODY).digest("hex") });
		expect(deliveryAuthentic(signed, SECRET, sent, NOW)).toBe(false);
	});

	it("refuses a body changed after signing", () => {
		const signature = hmac("sha256", BODY).digest("hex");
		const changed = delivery({ "X-Signature": signature }, BODY.replace("ISS-1", "ISS-2"));
		expect(deliveryAuthentic(signed, SECRET, changed, NOW)).toBe(false);
	});

	it("refuses a signature made with another secret, or the secret itself", () => {
		const forged = hmac("sha256", BODY, "another-secret-entirely").digest("hex");
		expect(deliveryAuthentic(signed, SECRET, delivery({ "X-Signature": forged }), NOW)).toBe(false);
		expect(deliveryAuthentic(signed, SECRET, delivery({ "X-Signature": SECRET }), NOW)).toBe(false);
	});
});

describe("GitHub and Linear, which sign the body", () => {
	it("admits GitHub's sha256= signature", () => {
		const signature = `sha256=${hmac("sha256", BODY).digest("hex")}`;
		const sent = delivery({ "X-Hub-Signature-256": signature });
		expect(deliveryAuthentic({ kind: "github" }, SECRET, sent, NOW)).toBe(true);
		expect(deliveryAuthentic({ kind: "linear" }, SECRET, sent, NOW)).toBe(false);
	});

	it("admits Linear's bare hex signature", () => {
		const sent = delivery({ "Linear-Signature": hmac("sha256", BODY).digest("hex") });
		expect(deliveryAuthentic({ kind: "linear" }, SECRET, sent, NOW)).toBe(true);
	});
});

describe("Slack's signatures", () => {
	const slack: WebhookAuth = { kind: "slack" };

	function fromSlack(timestamp: number, body = BODY) {
		const signature = hmac("sha256", `v0:${timestamp}:${body}`).digest("hex");
		return delivery(
			{ "X-Slack-Request-Timestamp": String(timestamp), "X-Slack-Signature": `v0=${signature}` },
			body,
		);
	}

	it("admits a delivery Slack signed just now", () => {
		expect(deliveryAuthentic(slack, SECRET, fromSlack(NOW_SECONDS - 10), NOW)).toBe(true);
	});

	it("refuses a delivery replayed after five minutes", () => {
		expect(deliveryAuthentic(slack, SECRET, fromSlack(NOW_SECONDS - 301), NOW)).toBe(false);
	});

	it("refuses a delivery without its timestamp", () => {
		const { headers, ...rest } = fromSlack(NOW_SECONDS);
		const unstamped = { ...rest, headers: { ...headers, "x-slack-request-timestamp": undefined } };
		expect(deliveryAuthentic(slack, SECRET, unstamped, NOW)).toBe(false);
	});

	it("answers its URL check only for a Slack routine", () => {
		const check = {
			type: "url_verification",
			challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7",
		};
		expect(slackChallengeOf(slack, check)).toBe(check.challenge);
		expect(slackChallengeOf({ kind: "bearer" }, check)).toBeUndefined();
		expect(slackChallengeOf(slack, { type: "event_callback", event_id: "Ev1" })).toBeUndefined();
	});

	it("names the delivery by its event", () => {
		const body = JSON.stringify({ type: "event_callback", event_id: "Ev08MFMKH6" });
		expect(deliveryIdOf(slack, null, fromSlack(NOW_SECONDS, body))).toBe("Ev08MFMKH6");
	});
});

describe("Stripe's signatures", () => {
	const stripe: WebhookAuth = { kind: "stripe" };

	function fromStripe(timestamp: number, secrets: string[], body = BODY) {
		const signatures = secrets.map(
			(secret) => `v1=${hmac("sha256", `${timestamp}.${body}`, secret).digest("hex")}`,
		);
		return delivery({ "Stripe-Signature": [`t=${timestamp}`, ...signatures].join(",") }, body);
	}

	it("admits a delivery Stripe signed just now", () => {
		expect(deliveryAuthentic(stripe, SECRET, fromStripe(NOW_SECONDS, [SECRET]), NOW)).toBe(true);
	});

	it("admits a delivery signed with each secret while Stripe rolls them", () => {
		const rolling = fromStripe(NOW_SECONDS, ["whsec_the_old_one_000000", SECRET]);
		expect(deliveryAuthentic(stripe, SECRET, rolling, NOW)).toBe(true);
	});

	it("refuses a delivery replayed after five minutes", () => {
		expect(deliveryAuthentic(stripe, SECRET, fromStripe(NOW_SECONDS - 301, [SECRET]), NOW)).toBe(
			false,
		);
	});

	it("names the delivery by its event", () => {
		const body = JSON.stringify({
			id: "evt_1NG8Du2eZvKYlo2CUI79vXWy",
			object: "event",
			type: "invoice.paid",
		});
		expect(deliveryIdOf(stripe, null, fromStripe(NOW_SECONDS, [SECRET], body))).toBe(
			"evt_1NG8Du2eZvKYlo2CUI79vXWy",
		);
	});
});

describe("delivery ids", () => {
	const bearer: WebhookAuth = { kind: "bearer" };

	it("reads a generic webhook's from the header it names, in any case", () => {
		expect(deliveryIdOf(bearer, "X-Request-Id", delivery({ "x-request-id": "req-1" }))).toBe(
			"req-1",
		);
		expect(deliveryIdOf(bearer, "x-request-id", delivery({ "X-Request-ID": " req-2 " }))).toBe(
			"req-2",
		);
	});

	it("leaves a generic webhook's unnamed without a header to read, or when it is missing or empty", () => {
		const sent = delivery({ "Idempotency-Key": "delivery-1" });
		expect(deliveryIdOf(bearer, null, sent)).toBeNull();
		expect(deliveryIdOf(bearer, "X-Request-Id", sent)).toBeNull();
		expect(
			deliveryIdOf(bearer, "Idempotency-Key", delivery({ "Idempotency-Key": " " })),
		).toBeNull();
	});

	it("ignores the ids other senders use and the body's, for a generic webhook", () => {
		const sent = delivery(
			{ "Svix-Id": "msg_1", "Webhook-Id": "wh_1", "X-GitHub-Delivery": "gh-1" },
			JSON.stringify({ event_id: "Ev1", object: "event", id: "evt_1" }),
		);
		expect(deliveryIdOf(bearer, "Idempotency-Key", sent)).toBeNull();
	});

	it("reads GitHub's and Linear's from their own header, whatever header is named", () => {
		const sent = delivery({
			"X-GitHub-Delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
			"Linear-Delivery": "234d1a4e-b617-4388-90fe-adc3633d6b72",
			"X-Request-Id": "req-1",
		});
		expect(deliveryIdOf({ kind: "github" }, "X-Request-Id", sent)).toBe(
			"72d3162e-cc78-11e3-81ab-4c9367dc0958",
		);
		expect(deliveryIdOf({ kind: "linear" }, "X-Request-Id", sent)).toBe(
			"234d1a4e-b617-4388-90fe-adc3633d6b72",
		);
	});
});

describe("new secrets", () => {
	it("marks each kind's secrets so they can be told apart", () => {
		expect(generateSecret("hmac")).toMatch(/^whsec_[\w-]{43}$/);
		expect(generateSecret("api_key")).toMatch(/^sk_rt_[\w-]{43}$/);
		expect(generateSecret("bearer")).toMatch(/^rtb_[\w-]{43}$/);
		expect(generateSecret("basic")).toMatch(/^[\w-]{43}$/);
	});
});
