import type { Workspace } from "@sugabots/contracts";
import { unimplemented } from "@sugabots/core/testing";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { WorkspaceTimeZone } from "@sugabots/core/workspaces/time-zone/workspace-time-zone";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy } from "../../http/app.test-support.ts";

/**
 * Creating a workspace and moving it to another time zone, over doubles of
 * `Membership` and `WorkspaceTimeZone`. What they store is their own tests'.
 */

const resolveUser: UserResolver = async () => ({
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Ada",
	email: "ada@example.com",
	image: null,
});

const created: Workspace = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Nitric",
	slug: "nitric",
	timeZone: "Australia/Sydney",
	setupCompletedAt: null,
};

const createWith = (create: Membership.Interface["create"], payload: unknown) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveUser), unimplemented(Membership.Service, { create })),
	).request("/workspaces", {
		method: "POST",
		headers: { authorization: "Bearer token", "content-type": "application/json" },
		body: JSON.stringify(payload),
	});

describe("creating a workspace", () => {
	it("creates it in the time zone it is given", async () => {
		const create = vi.fn<Membership.Interface["create"]>(() => Effect.succeed(created));

		const response = await createWith(create, {
			name: "Nitric",
			slug: "nitric",
			timeZone: "Australia/Sydney",
		});

		expect(response.status).toBe(201);
		expect(await response.json()).toEqual(created);
		expect(create).toHaveBeenCalledWith({
			details: { name: "Nitric", slug: "nitric", timeZone: "Australia/Sydney" },
		});
	});

	it.each([
		["a zone nobody has", "Mars/Olympus"],
		["an offset, which Postgres reads backwards", "+05:00"],
	])("refuses %s", async (_, timeZone) => {
		const create = vi.fn<Membership.Interface["create"]>(() => Effect.succeed(created));

		const response = await createWith(create, { name: "Nitric", slug: "nitric", timeZone });

		expect(response.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("refuses a time zone the database does not have", async () => {
		const response = await createWith(() => Effect.fail(new Membership.TimeZoneUnknown()), {
			name: "Nitric",
			slug: "nitric",
			timeZone: "Australia/Sydney",
		});

		expect(response.status).toBe(400);
	});
});

const changeWith = (change: WorkspaceTimeZone.Interface["change"], payload: unknown) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveUser), unimplemented(WorkspaceTimeZone.Service, { change })),
	).request("/workspaces/nitric/time-zone", {
		method: "PUT",
		headers: { authorization: "Bearer token", "content-type": "application/json" },
		body: JSON.stringify(payload),
	});

describe("moving a workspace to another time zone", () => {
	it("moves it to the zone it is given", async () => {
		const change = vi.fn<WorkspaceTimeZone.Interface["change"]>(() => Effect.void);

		const response = await changeWith(change, { timeZone: "Asia/Tokyo" });

		expect(response.status).toBe(204);
		expect(change).toHaveBeenCalledWith({ workspace: "nitric", timeZone: "Asia/Tokyo" });
	});

	it("refuses a zone nobody has", async () => {
		const change = vi.fn<WorkspaceTimeZone.Interface["change"]>(() => Effect.void);

		const response = await changeWith(change, { timeZone: "Mars/Olympus" });

		expect(response.status).toBe(400);
		expect(change).not.toHaveBeenCalled();
	});

	it("refuses a time zone the database does not have", async () => {
		const response = await changeWith(() => Effect.fail(new Membership.TimeZoneUnknown()), {
			timeZone: "Asia/Tokyo",
		});

		expect(response.status).toBe(400);
	});
});
