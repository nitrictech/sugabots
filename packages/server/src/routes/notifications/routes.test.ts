import { Operations } from "@sugabots/core/operations/registry";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { MemberResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy, signedInWith } from "../../http/app.test-support.ts";

/**
 * The notifications routes, over doubles of their operations, so what is
 * under test is what each operation is asked and what a refusal means over
 * HTTP. What a member's choices do is `notifications/notifications.test.ts`'s.
 */

const BOT = "0199a3a0-0000-7000-8000-000000000001";

const resolveMember: MemberResolver = async () => ({
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Ada",
	email: "ada@example.com",
	image: null,
});

/** The app with `operations` as the only operations it has. */
const app = (operations: Partial<Operations.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveMember), unimplemented(Operations.Service, operations)),
	);

const putting = (payload: unknown): RequestInit => ({
	method: "PUT",
	headers: { ...signedInWith("token"), "content-type": "application/json" },
	body: JSON.stringify(payload),
});

describe("a member's notifications in a project or bot", () => {
	it("sets the level asked for, at the place in the path", async () => {
		const setLevel = vi.fn<Operations.Interface["notifications.setLevel"]>(() => Effect.void);

		const response = await app({ "notifications.setLevel": setLevel }).request(
			`/notifications/bot/${BOT}/level`,
			putting({ level: "all" }),
		);

		expect(response.status).toBe(204);
		expect(setLevel).toHaveBeenCalledWith(
			expect.anything(),
			{ kind: "bot", id: BOT, level: "all" },
			expect.anything(),
		);
	});

	it("mutes until the time asked for", async () => {
		const until = "2026-11-25T09:00:00.000Z";
		const mute = vi.fn<Operations.Interface["notifications.mute"]>(() => Effect.void);

		const response = await app({ "notifications.mute": mute }).request(
			`/notifications/bot/${BOT}/mute`,
			putting({ until }),
		);

		expect(response.status).toBe(204);
		expect(mute).toHaveBeenCalledWith(
			expect.anything(),
			{ kind: "bot", id: BOT, until },
			expect.anything(),
		);
	});
});
