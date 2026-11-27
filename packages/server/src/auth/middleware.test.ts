import { Operations } from "@sugabots/core/operations/registry";
import type { Principal } from "@sugabots/core/principal";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
	createTestApp,
	identifiedBy,
	sessionTokenIn,
	signedInWith,
} from "../http/app.test-support.ts";

/**
 * The `Session` middleware's principal: what an operation behind it is called
 * for, over a double of the operations, so what is under test is the
 * authentication and the call, not the operation.
 */

const PROJECT = "0199a3a0-0000-7000-8000-0000000000a1";

const ada = {
	id: "0199a3a0-0000-7000-8000-000000000011",
	email: "ada@example.com",
	name: "Ada",
	image: null,
};

/** What an operation was called with, as the session authenticator made its principal. */
interface Called {
	readonly principal: {
		readonly kind: string;
		readonly member?: string;
		readonly session?: string;
	};
	readonly call: unknown;
}

const seen = (principal: Principal) =>
	principal._tag === "MemberSession"
		? { kind: principal._tag, member: principal.member, session: principal.session }
		: { kind: principal._tag };

describe("the Session middleware", () => {
	/** The app with Ada's session cookie read by `reads`, and `projects.listMembers` recording its calls. */
	const appRecording = (reads: string[], calls: Called[]) =>
		createTestApp(
			Layer.merge(
				identifiedBy(async (headers) => {
					const token = sessionTokenIn(headers);
					reads.push(token ?? "");
					return token === "ada-token" ? ada : null;
				}),
				unimplemented(Operations.Service, {
					"projects.listMembers": (principal, _input, call) =>
						Effect.sync(() => {
							calls.push({ principal: seen(principal), call });
							return [];
						}),
				}),
			),
		);

	it("reads the session cookie once per request, and calls the operation for that member's session", async () => {
		const reads: string[] = [];
		const calls: Called[] = [];
		const app = appRecording(reads, calls);

		const first = await app.request(`/projects/${PROJECT}/members`, {
			headers: signedInWith("ada-token"),
		});
		const second = await app.request(`/projects/${PROJECT}/members`, {
			headers: signedInWith("ada-token"),
		});

		expect([first.status, second.status]).toEqual([200, 200]);
		expect(reads).toEqual(["ada-token", "ada-token"]);
		expect(calls.map(({ principal }) => principal)).toEqual([
			{ kind: "MemberSession", member: ada.id, session: `session-of-${ada.id}` },
			{ kind: "MemberSession", member: ada.id, session: `session-of-${ada.id}` },
		]);
		expect(calls.map(({ call }) => call)).toEqual([{ kind: "request" }, { kind: "request" }]);
	});
});
