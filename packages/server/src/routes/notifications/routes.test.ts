import type { PushDevice } from "@sugabots/contracts";
import { Notifications } from "@sugabots/core/notifications/notifications";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy, WEB_ORIGIN } from "../../http/app.test-support.ts";

/**
 * Registering a phone, over a double of `Notifications`. What registering
 * keeps and pushes is `notifications.test.ts`'s.
 */

const resolveUser: UserResolver = async () => ({
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Ada",
	email: "ada@example.com",
	image: null,
});

const iphone: PushDevice = {
	service: "apns",
	token: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
	environment: "production",
};

const register = (
	registerDevice: Notifications.Interface["registerDevice"],
	credentials: Record<string, string>,
	signedInAs: UserResolver = resolveUser,
) =>
	createTestApp(
		Layer.merge(identifiedBy(signedInAs), unimplemented(Notifications.Service, { registerDevice })),
	).request("/notifications/device", {
		method: "PUT",
		headers: { "content-type": "application/json", ...credentials },
		body: JSON.stringify(iphone),
	});

const fromTheApp = { authorization: "Bearer app-token" };
const fromABrowser = { cookie: "better-auth.session_token=browser", origin: WEB_ORIGIN };

describe("registering a phone", () => {
	it("registers the phone the app is signed in on, saying whether the server can push to it", async () => {
		const registerDevice = vi.fn<Notifications.Interface["registerDevice"]>(() =>
			Effect.succeed({ available: true }),
		);

		const response = await register(registerDevice, fromTheApp);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ available: true });
		expect(registerDevice).toHaveBeenCalledWith(expect.any(String), iphone);
	});

	it("refuses a browser's session, which has no phone and must not be lengthened", async () => {
		const registerDevice = vi.fn<Notifications.Interface["registerDevice"]>(() =>
			Effect.succeed({ available: true }),
		);

		const response = await register(registerDevice, fromABrowser);

		expect(response.status).toBe(403);
		expect(registerDevice).not.toHaveBeenCalled();
	});

	it("refuses somebody who isn't signed in", async () => {
		const registerDevice = vi.fn<Notifications.Interface["registerDevice"]>(() =>
			Effect.succeed({ available: true }),
		);

		const response = await register(registerDevice, fromTheApp, async () => null);

		expect(response.status).toBe(401);
		expect(registerDevice).not.toHaveBeenCalled();
	});

	it("answers a token its push service refused as a bad request", async () => {
		const response = await register(
			() => Effect.fail(new Notifications.PushDeviceRefused({ reason: "BadDeviceToken" })),
			fromTheApp,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			message: "This build of the app can't be notified by this server.",
		});
	});
});

describe("unregistering a phone", () => {
	it("stops pushing to the phone of the session that asks, from the app or a browser", async () => {
		const unregisterDevice = vi.fn<Notifications.Interface["unregisterDevice"]>(() => Effect.void);
		const app = createTestApp(
			Layer.merge(
				identifiedBy(resolveUser),
				unimplemented(Notifications.Service, { unregisterDevice }),
			),
		);

		const fromApp = await app.request("/notifications/device", {
			method: "DELETE",
			headers: fromTheApp,
		});
		const fromBrowser = await app.request("/notifications/device", {
			method: "DELETE",
			headers: fromABrowser,
		});

		expect([fromApp.status, fromBrowser.status]).toEqual([204, 204]);
		expect(unregisterDevice).toHaveBeenCalledTimes(2);
	});
});
