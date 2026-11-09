import { generateKeyPairSync, verify } from "node:crypto";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import type { NotificationContent } from "@sugabots/contracts";
import { Effect, Exit, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Push } from "../push.ts";
import { fromApns } from "./apns.ts";

/*
 * Apple's push service, stood in for by a local HTTP/2 server that answers
 * each request as the test says and keeps what it was sent.
 */

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

const notification: NotificationContent = {
	title: "Ada mentioned you in Launch",
	body: "@bob is the quote ready?",
	tag: "conversation:0199a3a0-0000-7000-8000-000000000001",
	path: "/acme/activity/launch/0199a3a0-0000-7000-8000-000000000001?message=m1",
	conversationId: "0199a3a0-0000-7000-8000-000000000001",
};

const device: Push.DeviceOf<"apns"> = {
	service: "apns",
	token: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
	environment: "development",
};

let server: Http2Server;
let origin: string;
/** How the stand-in answers: with a status, or with its headers and then nothing. */
let answer: { status: number; reason?: string; stall?: boolean };
const received: { headers: IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
	server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
			response.writeHead(answer.status, { "content-type": "application/json" });
			if (answer.stall) {
				response.write("{");
				return;
			}
			response.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : "");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
	received.length = 0;
	answer = { status: 200 };
});

/** Runs `use` with the implementation, pointed at the stand-in. */
const withApns = <A, E>(use: (apns: Push.Sender<"apns">) => Effect.Effect<A, E>, key = pem) =>
	Effect.runPromiseExit(
		Effect.scoped(
			Effect.gen(function* () {
				const apns = yield* fromApns({
					keyId: "KEY1234567",
					teamId: "TEAM123456",
					privateKey: Redacted.make(key),
					topic: "ai.sugabots.app",
					origins: { development: origin, production: "http://127.0.0.1:1" },
					timeoutMs: 300,
				});
				return yield* use(apns);
			}),
		),
	);

/** Sends `content` to `device` through the implementation. */
const send = (key = pem, content = notification) =>
	withApns((apns) => apns.send(device, content), key);

describe("Apple's push service", () => {
	it("is sent the alert for the device, signed with the push key, leading to the notification's page", async () => {
		expect(Exit.isSuccess(await send())).toBe(true);

		const [request] = received;
		expect(request?.headers).toMatchObject({
			":method": "POST",
			":path": `/3/device/${device.token}`,
			"apns-topic": "ai.sugabots.app",
			"apns-push-type": "alert",
		});
		expect(JSON.parse(request?.body ?? "")).toEqual({
			aps: {
				alert: { title: notification.title, body: notification.body },
				sound: "default",
				"thread-id": notification.tag,
			},
			path: notification.path,
			conversationId: notification.conversationId,
		});

		const [scheme, token] = String(request?.headers.authorization).split(" ");
		const [header, claims, signature] = (token ?? "").split(".");
		expect(scheme).toBe("bearer");
		expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
			alg: "ES256",
			kid: "KEY1234567",
		});
		expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString())).toEqual({
			iss: "TEAM123456",
			iat: expect.any(Number),
		});
		expect(
			verify(
				"sha256",
				Buffer.from(`${header}.${claims}`),
				{ key: publicKey, dsaEncoding: "ieee-p1363" },
				Buffer.from(signature ?? "", "base64url"),
			),
		).toBe(true);
	});

	it("checks a token with a silent background push that shows nothing", async () => {
		expect(Exit.isSuccess(await withApns((apns) => apns.check(device)))).toBe(true);

		const [request] = received;
		expect(request?.headers).toMatchObject({
			":path": `/3/device/${device.token}`,
			"apns-push-type": "background",
			"apns-priority": "5",
		});
		expect(JSON.parse(request?.body ?? "")).toEqual({ aps: { "content-available": 1 } });
	});

	it("says a device is gone only when Apple says its app was removed", async () => {
		answer = { status: 410, reason: "Unregistered" };

		expect(await send()).toEqual(Exit.fail(new Push.DeviceGone({ reason: "Unregistered" })));
	});

	it.each(["BadDeviceToken", "DeviceTokenNotForTopic"])(
		"says the token was refused, not that the device is gone, when Apple answers 400 %s",
		async (reason) => {
			answer = { status: 400, reason };

			expect(await send()).toEqual(Exit.fail(new Push.TokenRefused({ reason })));
		},
	);

	it("fails without forgetting the device when Apple can't take the push for now", async () => {
		answer = { status: 503, reason: "ServiceUnavailable" };

		expect(await send()).toEqual(
			Exit.fail(new Push.DeliveryFailed({ service: "apns", cause: "503 ServiceUnavailable" })),
		);
	});

	it("gives up on an answer that stops halfway, rather than waiting forever", async () => {
		answer = { status: 200, stall: true };

		const failure = await withApns((apns) => Effect.flip(apns.send(device, notification)));

		expect(failure).toEqual(Exit.succeed(expect.any(Push.DeliveryFailed)));
	});

	it("connects again for the next push after one that stalled took the connection down", async () => {
		answer = { status: 200, stall: true };

		const exit = await withApns((apns) =>
			Effect.gen(function* () {
				yield* Effect.flip(apns.send(device, notification));
				answer = { status: 200 };
				yield* apns.send(device, notification);
			}),
		);

		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("signs a new provider token once Apple says the one it was sent has expired", async () => {
		answer = { status: 403, reason: "ExpiredProviderToken" };

		await withApns((apns) =>
			Effect.gen(function* () {
				yield* Effect.flip(apns.send(device, notification));
				answer = { status: 200 };
				yield* apns.send(device, notification);
				yield* apns.send(device, notification);
			}),
		);

		const [expired, renewed, reused] = received.map(({ headers }) => headers.authorization);
		expect(renewed).not.toEqual(expired);
		expect(reused).toEqual(renewed);
	});

	it("fails the delivery, not the token, when the push key may not push to the app at all", async () => {
		answer = { status: 400, reason: "TopicDisallowed" };

		expect(await send()).toEqual(
			Exit.fail(new Push.DeliveryFailed({ service: "apns", cause: "400 TopicDisallowed" })),
		);
	});

	it.each([
		["plain text", "The sandbox stopped answering. ".repeat(500)],
		["emoji, four bytes each", "🚨".repeat(3000)],
		["quotes and line breaks, which JSON escapes", '"quoted"\n'.repeat(1000)],
	])("cuts a long body of %s short, so the push stays within Apple's 4 KB", async (_kind, body) => {
		expect(Exit.isSuccess(await send(pem, { ...notification, body }))).toBe(true);

		const [request] = received;
		expect(Buffer.byteLength(request?.body ?? "")).toBeLessThanOrEqual(4096);
		expect(JSON.parse(request?.body ?? "").aps.alert.body).toMatch(/…$/);
	});

	it("takes the key with its line breaks written as \\n, as an environment file holds it", async () => {
		expect(Exit.isSuccess(await send(pem.replaceAll("\n", "\\n")))).toBe(true);
	});

	it("refuses a key that isn't one", async () => {
		expect(await send("not a key")).toEqual(
			Exit.fail(
				new Push.InvalidConfig({ message: "APNS_PRIVATE_KEY must be the .p8 key's contents." }),
			),
		);
	});
});
