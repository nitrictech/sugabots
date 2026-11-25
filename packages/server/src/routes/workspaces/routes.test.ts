import type { Workspace } from "@sugabots/contracts";
import {
	EmailUnverified,
	OwnerStays,
	SubscriptionInUse,
	TimeZoneUnknown,
} from "@sugabots/contracts/errors/workspace";
import { Operations } from "@sugabots/core/operations/registry";
import type { Principal } from "@sugabots/core/principal";
import { unimplemented } from "@sugabots/core/testing";
import { DisplayName } from "@sugabots/errors";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { MemberResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy, signedInWith } from "../../http/app.test-support.ts";

/**
 * The workspace routes, over doubles of the workspace operations, so what is
 * under test is the routing, which principal each operation is called for,
 * and what each refusal means over HTTP. Who may do what is decided, and
 * tested, in core.
 */

const ADA = "0199a3a0-0000-7000-8000-000000000002";
const MEMBERSHIP = "0199a3a0-0000-7000-8000-000000000003";
const INVITATION = "0199a3a0-0000-7000-8000-000000000004";

const resolveMember: MemberResolver = async () => ({
	id: ADA,
	name: "Ada",
	email: "ada@example.com",
	image: null,
});

const created: Workspace = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Nitric",
	slug: "nitric",
	timeZone: "Australia/Sydney",
	setUpAt: null,
};

/** The app with `operations` as the only operations it has. */
const app = (operations: Partial<Operations.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveMember), unimplemented(Operations.Service, operations)),
	);

/** The member a principal is signed in as, as the session authenticator built it. */
const memberOf = (principal: Principal) =>
	principal._tag === "MemberSession" ? principal.member : undefined;

const sending = (method: string, payload?: unknown): RequestInit => ({
	method,
	headers: { ...signedInWith("token"), "content-type": "application/json" },
	...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
});

describe("creating a workspace", () => {
	const createWith = (create: Operations.Interface["workspaces.create"], payload: unknown) =>
		app({ "workspaces.create": create }).request("/workspaces", sending("POST", payload));

	it("creates it in the time zone it is given, for the member the session belongs to", async () => {
		let asked: unknown;
		const create = vi.fn<Operations.Interface["workspaces.create"]>((principal, input) =>
			Effect.sync(() => {
				asked = { ...input, memberId: memberOf(principal) };
				return created;
			}),
		);

		const response = await createWith(create, {
			name: "Nitric",
			slug: "nitric",
			timeZone: "Australia/Sydney",
		});

		expect(response.status).toBe(201);
		expect(await response.json()).toEqual(created);
		expect(asked).toEqual({
			name: "Nitric",
			slug: "nitric",
			timeZone: "Australia/Sydney",
			memberId: ADA,
		});
	});

	it.each([
		["a zone nobody has", "Mars/Olympus"],
		["an offset, which Postgres reads backwards", "+05:00"],
	])("refuses %s", async (_, timeZone) => {
		const create = vi.fn<Operations.Interface["workspaces.create"]>(() => Effect.succeed(created));

		const response = await createWith(create, { name: "Nitric", slug: "nitric", timeZone });

		expect(response.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("refuses a time zone the database does not have", async () => {
		const response = await createWith(() => Effect.fail(new TimeZoneUnknown()), {
			name: "Nitric",
			slug: "nitric",
			timeZone: "Australia/Sydney",
		});

		expect(response.status).toBe(400);
	});
});

describe("moving a workspace to another time zone", () => {
	const changeWith = (
		change: Operations.Interface["workspaces.changeTimeZone"],
		payload: unknown,
	) =>
		app({ "workspaces.changeTimeZone": change }).request(
			"/workspaces/nitric/time-zone",
			sending("PUT", payload),
		);

	it("moves it to the zone it is given", async () => {
		const change = vi.fn<Operations.Interface["workspaces.changeTimeZone"]>(() => Effect.void);

		const response = await changeWith(change, { timeZone: "Asia/Tokyo" });

		expect(response.status).toBe(204);
		expect(change).toHaveBeenCalledWith(
			expect.anything(),
			{ workspace: "nitric", timeZone: "Asia/Tokyo" },
			expect.anything(),
		);
	});

	it("refuses a zone nobody has", async () => {
		const change = vi.fn<Operations.Interface["workspaces.changeTimeZone"]>(() => Effect.void);

		const response = await changeWith(change, { timeZone: "Mars/Olympus" });

		expect(response.status).toBe(400);
		expect(change).not.toHaveBeenCalled();
	});

	it("refuses a time zone the database does not have", async () => {
		const response = await changeWith(() => Effect.fail(new TimeZoneUnknown()), {
			timeZone: "Asia/Tokyo",
		});

		expect(response.status).toBe(400);
	});
});

describe("who is in a workspace", () => {
	it("keeps a member a model provider signs in as", async () => {
		const inUse = new SubscriptionInUse({
			member: DisplayName.fromRecord("Bob"),
			providers: [DisplayName.fromRecord("ChatGPT")],
		});
		const routes = app({
			"workspaces.removeMembership": () => Effect.fail(inUse),
		});

		const removed = await routes.request(
			`/workspaces/nitric/memberships/${MEMBERSHIP}`,
			sending("DELETE"),
		);

		expect(removed.status).toBe(409);
		expect(await removed.json()).toMatchObject({
			_tag: "Conflict",
			message: inUse.userMessage,
			error: { _tag: "SubscriptionInUse" },
		});
	});

	it("reports the owner must hand over ownership before leaving", async () => {
		const response = await app({
			"workspaces.leave": () => Effect.fail(new OwnerStays()),
		}).request("/workspaces/nitric/leave", sending("POST"));

		expect(response.status).toBe(400);
	});
});

describe("an invitation", () => {
	it("tells the member it was sent to to verify their address first, with the code the SDK knows", async () => {
		const error = new EmailUnverified();
		const response = await app({
			"workspaces.acceptInvitation": () => Effect.fail(error),
		}).request(`/invitations/${INVITATION}/accept`, sending("POST"));

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			_tag: "Forbidden",
			message: error.userMessage,
			details: "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION",
		});
	});

	it("is accepted for the member the session belongs to", async () => {
		let asked: unknown;
		const response = await app({
			"workspaces.acceptInvitation": (principal, input) =>
				Effect.sync(() => {
					asked = { ...input, memberId: memberOf(principal) };
					return { workspaceId: created.id };
				}),
		}).request(`/invitations/${INVITATION}/accept`, sending("POST"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ workspaceId: created.id });
		expect(asked).toEqual({ invitationId: INVITATION, memberId: ADA });
	});
});
