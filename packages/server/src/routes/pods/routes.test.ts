import type { Pod } from "@sugabots/contracts";
import { DEFAULT_POD_ROUTING, podSchema } from "@sugabots/contracts";
import { BadRequest, Conflict, Forbidden, NotFound } from "@sugabots/contracts/http";
import { ActionForbidden, ResourceHidden } from "@sugabots/core/authorization/access";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { podPermissions } from "@sugabots/core/authorization/permissions";
import { unimplemented } from "@sugabots/core/testing";
import { PodAdministration } from "@sugabots/core/workspaces/pods/pod-administration";
import { PodRepository } from "@sugabots/core/workspaces/pods/pod-repository";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy } from "../../http/app.test-support.ts";

/**
 * The pod routes, over doubles of `PodAdministration`, so what is under test
 * is the routing, who the administration is asked as, and what each refusal
 * means over HTTP. Who may do what is decided, and tested, in
 * `pods/pods.test.ts`.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const POD = "0199a3a0-0000-7000-8000-0000000000a1";

const admin = {
	id: "0199a3a0-0000-7000-8000-000000000011",
	email: "ada@example.com",
	name: "Ada",
	image: null,
};
const outsider = {
	id: "0199a3a0-0000-7000-8000-000000000014",
	email: "lee@example.com",
	name: "Lee",
	image: null,
};

const people = {
	"admin-token": admin,
	"outsider-token": outsider,
};

const resolveUser: UserResolver = async (headers) => {
	const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
	const user = people[token as keyof typeof people];
	return user ?? null;
};

const podFor = (userId: string, kind: Pod["kind"] = "shared"): Pod => ({
	id: POD,
	workspaceId: WORKSPACE,
	ownerId: kind === "personal" ? userId : null,
	kind,
	name: "Suga-Team",
	slug: "suga-team",
	color: kind === "shared" ? "green" : null,
	routing: DEFAULT_POD_ROUTING,
	permissions: podPermissions(
		{ userId, workspaceRole: "admin" },
		{ kind, ownerId: kind === "personal" ? userId : null, isExplicitMember: true },
	),
	createdAt: "2026-09-09T00:00:00.000Z",
});

/** The app with `pods` as the only pod methods it has. */
const app = (pods: Partial<PodAdministration.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveUser), unimplemented(PodAdministration.Service, pods)),
	);

const as = (token: string, init: RequestInit = {}) => ({
	...init,
	headers: {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		...init.headers,
	},
});

const json = (value: unknown) => ({ method: "POST", body: JSON.stringify(value) });

const failure = Schema.Union([BadRequest, Conflict, Forbidden, NotFound]);

const errorTag = async (response: Response) =>
	Schema.decodeUnknownSync(failure)(await response.json())._tag;

describe("GET /workspaces/:workspace/pods", () => {
	it("lists the pods as the person the session belongs to sees them", async () => {
		let asked: unknown;
		const response = await app({
			list: (input) =>
				Effect.map(CurrentActor.Service, ({ userId }) => {
					asked = { ...input, userId };
					return [podFor(userId)];
				}),
		}).request(`/workspaces/${WORKSPACE}/pods`, as("admin-token"));

		expect(response.status).toBe(200);
		expect(asked).toEqual({ workspace: WORKSPACE, userId: admin.id });
		expect(Schema.decodeUnknownSync(Schema.Array(podSchema))(await response.json())).toEqual([
			podFor(admin.id),
		]);
	});

	it("answers a workspace hidden from the caller as not found", async () => {
		const response = await app({
			list: () => Effect.fail(new ResourceHidden({ resource: "workspace" })),
		}).request(`/workspaces/${WORKSPACE}/pods`, as("outsider-token"));

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ _tag: "NotFound", message: "No such workspace" });
	});
});

describe("POST /workspaces/:workspace/pods", () => {
	it("creates one for an admin, and derives the slug from the name", async () => {
		let created: unknown;
		const response = await app({
			create: (input) => {
				created = { workspace: input.workspace, name: input.name, slug: input.slug };
				return Effect.succeed(podFor(admin.id));
			},
		}).request(`/workspaces/${WORKSPACE}/pods`, as("admin-token", json({ name: "Sales Team" })));

		expect(response.status).toBe(201);
		expect(created).toEqual({ workspace: WORKSPACE, name: "Sales Team", slug: "sales-team" });
	});

	it("answers an action the caller may not take as forbidden", async () => {
		const response = await app({
			create: () => Effect.fail(new ActionForbidden({ permission: "pod.create" })),
		}).request(`/workspaces/${WORKSPACE}/pods`, as("admin-token", json({ name: "Sales" })));

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			_tag: "Forbidden",
			message: "You are not allowed to do that",
		});
	});

	it("rejects a name nothing can be slugged from", async () => {
		const response = await app({}).request(
			`/workspaces/${WORKSPACE}/pods`,
			as("admin-token", json({ name: "!!!" })),
		);

		expect(response.status).toBe(400);
		expect(Schema.decodeUnknownSync(BadRequest)(await response.json()).message).toBe(
			"That name cannot be a pod's address",
		);
	});

	it.each(["Personal", "PERSONAL!!!"])(
		"explains the reserved address with a public message for %s",
		async (name) => {
			const response = await app({}).request(
				`/workspaces/${WORKSPACE}/pods`,
				as("admin-token", json({ name })),
			);

			expect(response.status).toBe(400);
			expect(Schema.decodeUnknownSync(BadRequest)(await response.json()).message).toBe(
				'"personal" is reserved for your Personal pod. Choose another name.',
			);
		},
	);

	it.each([{ name: "Personal" }, { name: "Mine", slug: "personal" }])(
		"keeps the Personal pods' slug from a shared pod: %o",
		async (body) => {
			const response = await app({}).request(
				`/workspaces/${WORKSPACE}/pods`,
				as("admin-token", json(body)),
			);

			expect(response.status).toBe(400);
		},
	);

	it("rejects a body that is not a pod, with the field issues", async () => {
		const response = await app({}).request(
			`/workspaces/${WORKSPACE}/pods`,
			as("admin-token", json({ name: "" })),
		);

		expect(response.status).toBe(400);
		expect(Schema.decodeUnknownSync(BadRequest)(await response.json()).details).toBeDefined();
	});

	it("reports a taken slug as a conflict", async () => {
		const response = await app({
			create: (input) => Effect.fail(new PodRepository.PodSlugTaken({ slug: input.slug })),
		}).request(`/workspaces/${WORKSPACE}/pods`, as("admin-token", json({ name: "Suga-Team" })));

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			_tag: "Conflict",
			message: "A pod with that address already exists in this workspace",
		});
	});
});

describe("changing a pod", () => {
	it("renames the pod in the path", async () => {
		const response = await app({
			update: ({ podId, changes }) =>
				Effect.succeed({ ...podFor(admin.id), id: podId, name: changes.name ?? "" }),
		}).request(
			`/pods/${POD}`,
			as("admin-token", { method: "PATCH", body: JSON.stringify({ name: "Platform" }) }),
		);

		expect(response.status).toBe(200);
		expect(Schema.decodeUnknownSync(podSchema)(await response.json()).name).toBe("Platform");
	});

	it("answers a pod hidden from the caller as not found", async () => {
		const response = await app({
			update: () => Effect.fail(new ResourceHidden({ resource: "pod" })),
		}).request(
			`/pods/${POD}`,
			as("outsider-token", { method: "PATCH", body: JSON.stringify({ name: "Platform" }) }),
		);

		expect(response.status).toBe(404);
		expect(await errorTag(response)).toBe("NotFound");
	});

	it("reports a patch that changes nothing as a bad request", async () => {
		const response = await app({
			update: () => Effect.fail(new PodAdministration.EmptyPodUpdate()),
		}).request(`/pods/${POD}`, as("admin-token", { method: "PATCH", body: JSON.stringify({}) }));

		expect(response.status).toBe(400);
	});

	it("reports the refusal to rename a Personal pod as a bad request", async () => {
		const response = await app({
			update: () => Effect.fail(new PodRepository.PersonalPodFixed({ attempted: "rename" })),
		}).request(
			`/pods/${POD}`,
			as("admin-token", { method: "PATCH", body: JSON.stringify({ name: "Mine" }) }),
		);

		expect(response.status).toBe(400);
	});

	it("deletes a pod", async () => {
		const response = await app({ remove: () => Effect.void }).request(
			`/pods/${POD}`,
			as("admin-token", { method: "DELETE" }),
		);
		expect(response.status).toBe(204);
	});

	it("reports the refusal to delete a Personal pod as a bad request", async () => {
		const response = await app({
			remove: () => Effect.fail(new PodRepository.PersonalPodFixed({ attempted: "delete" })),
		}).request(`/pods/${POD}`, as("admin-token", { method: "DELETE" }));

		expect(response.status).toBe(400);
	});
});

describe("pod membership", () => {
	it("reports somebody outside the workspace as a bad request", async () => {
		const response = await app({
			addMember: () => Effect.fail(new PodAdministration.NotInWorkspace()),
		}).request(`/pods/${POD}/members`, as("admin-token", json({ userId: outsider.id })));

		expect(response.status).toBe(400);
	});

	it("reports removing somebody who was not there as not found", async () => {
		const response = await app({
			removeMember: () => Effect.fail(new PodAdministration.NotInPod()),
		}).request(`/pods/${POD}/members/${outsider.id}`, as("admin-token", { method: "DELETE" }));

		expect(response.status).toBe(404);
	});

	it("reports the refusal to staff a Personal pod as a bad request", async () => {
		const response = await app({
			addMember: () =>
				Effect.fail(new PodAdministration.PersonalPodMembershipFixed({ attempted: "add" })),
		}).request(`/pods/${POD}/members`, as("admin-token", json({ userId: outsider.id })));

		expect(response.status).toBe(400);
	});
});
