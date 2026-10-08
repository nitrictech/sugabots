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

describe("signatures over the body", () => {
	const linear: WebhookAuth = {
		kind: "hmac",
		format: "body",
		header: "Linear-Signature",
		algorithm: "sha256",
	};

	it("admits Linear's bare hex signature", () => {
		const signed = delivery({ "Linear-Signature": hmac("sha256", BODY).digest("hex") });
		expect(deliveryAuthentic(linear, SECRET, signed, NOW)).toBe(true);
	});

	it("admits GitHub's signature, prefixed with its algorithm", () => {
		const github: WebhookAuth = { ...linear, header: "X-Hub-Signature-256" };
		const signature = `sha256=${hmac("sha256", BODY).digest("hex")}`;
		expect(
			deliveryAuthentic(github, SECRET, delivery({ "X-Hub-Signature-256": signature }), NOW),
		).toBe(true);
	});

	it("admits Shopify's base64 signature", () => {
		const shopify: WebhookAuth = { ...linear, header: "X-Shopify-Hmac-Sha256" };
		const signature = hmac("sha256", BODY).digest("base64");
		expect(
			deliveryAuthentic(shopify, SECRET, delivery({ "X-Shopify-Hmac-Sha256": signature }), NOW),
		).toBe(true);
	});

	it("signs with SHA-512 when chosen", () => {
		const sha512: WebhookAuth = { ...linear, algorithm: "sha512" };
		const signed = delivery({ "Linear-Signature": hmac("sha512", BODY).digest("hex") });
		expect(deliveryAuthentic(sha512, SECRET, signed, NOW)).toBe(true);
		expect(deliveryAuthentic(linear, SECRET, signed, NOW)).toBe(false);
	});

	it("refuses a body changed after signing", () => {
		const signature = hmac("sha256", BODY).digest("hex");
		const changed = delivery({ "Linear-Signature": signature }, BODY.replace("ISS-1", "ISS-2"));
		expect(deliveryAuthentic(linear, SECRET, changed, NOW)).toBe(false);
	});

	it("refuses a signature made with another secret", () => {
		const signature = hmac("sha256", BODY, "another-secret-entirely").digest("hex");
		expect(
			deliveryAuthentic(linear, SECRET, delivery({ "Linear-Signature": signature }), NOW),
		).toBe(false);
	});

	it("refuses the secret itself in place of a signature", () => {
		expect(deliveryAuthentic(linear, SECRET, delivery({ "Linear-Signature": SECRET }), NOW)).toBe(
			false,
		);
	});
});

describe("Slack's signatures", () => {
	const slack: WebhookAuth = { kind: "hmac", format: "slack" };

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
		expect(deliveryIdOf(slack, fromSlack(NOW_SECONDS, body))).toBe("Ev08MFMKH6");
	});
});

describe("Stripe's signatures", () => {
	const stripe: WebhookAuth = { kind: "hmac", format: "stripe" };

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
		const body = JSON.stringify({ id: "evt_1NG8Du2eZvKYlo2CUI79vXWy", type: "invoice.paid" });
		expect(deliveryIdOf(stripe, fromStripe(NOW_SECONDS, [SECRET], body))).toBe(
			"evt_1NG8Du2eZvKYlo2CUI79vXWy",
		);
	});
});

describe("delivery ids", () => {
	it.each([
		["Idempotency-Key", "delivery-1"],
		["Linear-Delivery", "234d1a4e-b617-4388-90fe-adc3633d6b72"],
		["X-GitHub-Delivery", "72d3162e-cc78-11e3-81ab-4c9367dc0958"],
	])("names a delivery by its %s header", (header, id) => {
		expect(deliveryIdOf({ kind: "bearer" }, delivery({ [header]: id }))).toBe(id);
	});

	it("leaves a delivery without one unnamed", () => {
		expect(deliveryIdOf({ kind: "bearer" }, delivery({}))).toBeNull();
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
