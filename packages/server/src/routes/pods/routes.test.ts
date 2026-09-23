import type { Pod } from "@sugabots/contracts";
import { DEFAULT_POD_ROUTING, podSchema } from "@sugabots/contracts";
import { BadRequest, Conflict, Forbidden, NotFound } from "@sugabots/contracts/http";
import { podPermissions } from "@sugabots/core/workspaces/permissions";
import { PersonalPodFixed, type PodStore, SlugTaken } from "@sugabots/core/workspaces/pods/store";
import { testAuthorization } from "@sugabots/core/workspaces/testing";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionResolver } from "../../auth/session.ts";
import { createTestApp } from "../../http/app.test-support.ts";

/**
 * The pod routes, over a fake store and the real policy against facts each
 * case states, so what is under test is the routing and the authorisation
 * rather than Postgres. The store is exercised against a real database in
 * `pods/store.test.ts`.
 *
 * The rules these are mostly about: an admin reaches every shared pod without
 * being in it, a member reaches only the pods they have joined, and anything
 * the caller cannot reach is `NotFound` rather than `Forbidden`, so an id
 * cannot be probed for.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const POD = "0199a3a0-0000-7000-8000-0000000000a1";
const OTHER = "0199a3a0-0000-7000-8000-0000000000a2";

const admin = {
	id: "0199a3a0-0000-7000-8000-000000000011",
	email: "ada@example.com",
	name: "Ada",
	image: null,
};
const member = {
	id: "0199a3a0-0000-7000-8000-000000000012",
	email: "sam@example.com",
	name: "Sam",
	image: null,
};
const stranger = {
	id: "0199a3a0-0000-7000-8000-000000000013",
	email: "kim@example.com",
	name: "Kim",
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
	"member-token": member,
	"stranger-token": stranger,
	"outsider-token": outsider,
};

const resolveSession: SessionResolver = async (headers) => {
	const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
	const user = people[token as keyof typeof people];
	return user ? { user } : null;
};

/**
 * Ada administers the workspace and is *not* in the pod; Sam is in it as an
 * ordinary member; Kim is in the workspace and in no pod; Lee is nowhere.
 */
const world = (kind: Pod["kind"] = "shared") =>
	testAuthorization({
		id: WORKSPACE,
		roles: { [admin.id]: "admin", [member.id]: "member", [stranger.id]: "member" },
		pods: [
			{
				id: POD,
				kind,
				ownerId: kind === "personal" ? member.id : null,
				members: [member.id],
			},
		],
	});

const podFor = (userId: string, kind: Pod["kind"] = "shared"): Pod => ({
	id: POD,
	workspaceId: WORKSPACE,
	ownerId: kind === "personal" ? member.id : null,
	kind,
	name: "Suga-Team",
	slug: "suga-team",
	routing: DEFAULT_POD_ROUTING,
	permissions: podPermissions(
		{ userId, workspaceRole: userId === admin.id ? "admin" : "member" },
		{
			kind,
			ownerId: kind === "personal" ? member.id : null,
			isExplicitMember: userId === member.id,
		},
	),
	createdAt: "2026-09-09T00:00:00.000Z",
});

const row = (input: { name?: string; slug?: string } = {}) => ({
	id: POD,
	workspaceId: WORKSPACE,
	ownerId: null,
	kind: "shared" as const,
	name: input.name ?? "Suga-Team",
	slug: input.slug ?? "suga-team",
	routing: DEFAULT_POD_ROUTING,
	createdById: null,
	createdAt: new Date("2026-09-09T00:00:00.000Z"),
	updatedAt: new Date("2026-09-09T00:00:00.000Z"),
});

let store: PodStore;
let created: { name: string; slug: string } | undefined;
let updated: { name?: string; slug?: string } | undefined;
let added: string[];
let slugTaken: boolean;
let podKind: Pod["kind"];

beforeEach(() => {
	created = undefined;
	updated = undefined;
	added = [];
	slugTaken = false;
	podKind = "shared";

	store = {
		listVisible: (_workspaceId, actor) => Effect.succeed([podFor(actor.userId)]),
		create: (_workspaceId, creator, input) =>
			Effect.gen(function* () {
				if (slugTaken) {
					return yield* new SlugTaken({ slug: input.slug });
				}
				created = input;
				return { ...podFor(creator.userId), ...input };
			}),
		ensurePersonal: (_workspaceId, owner) =>
			Effect.succeed({ ...podFor(owner.userId, "personal"), name: "Personal" }),
		// The Personal-pod rules are the store's, and are tested against a real
		// database in `pods/store.test.ts`. What these cases are about is what
		// each of its refusals means over HTTP, so the fake raises them too.
		update: (_workspaceId, _podId, input) =>
			Effect.gen(function* () {
				if (podKind === "personal" && (input.name !== undefined || input.slug !== undefined)) {
					return yield* new PersonalPodFixed({ attempted: "rename" });
				}
				updated = input;
				return row(input);
			}),
		remove: () =>
			podKind === "personal"
				? Effect.fail(new PersonalPodFixed({ attempted: "delete" }))
				: Effect.void,
		listMembers: () => Effect.succeed([]),
		addMember: (_workspaceId, _podId, userId) =>
			Effect.sync(() => {
				if (podKind === "personal") return "personal_pod";
				if (userId === outsider.id) return "not_workspace_member";
				added.push(userId);
				return "added";
			}),
		removeMember: (_workspaceId, _podId, userId) =>
			Effect.sync(() => {
				if (podKind === "personal") return "personal_pod";
				return userId === member.id ? "removed" : "not_a_member";
			}),
	};
});

const app = () =>
	createTestApp({ resolveSession, authorization: world(podKind), stores: { pods: store } });

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

describe("GET /workspaces/:workspaceId/pods", () => {
	it("lists the pods a member can see", async () => {
		const response = await app().request(`/workspaces/${WORKSPACE}/pods`, as("member-token"));

		expect(response.status).toBe(200);
		expect(Schema.decodeUnknownSync(Schema.Array(podSchema))(await response.json())).toEqual([
			podFor(member.id),
		]);
	});

	it("hides a workspace the caller is not in, as not found", async () => {
		const response = await app().request(`/workspaces/${WORKSPACE}/pods`, as("outsider-token"));

		expect(response.status).toBe(404);
		expect(await errorTag(response)).toBe("NotFound");
	});

	it("answers no to a workspace id that is not a uuid, rather than failing", async () => {
		expect((await app().request("/workspaces/nonsense/pods", as("admin-token"))).status).toBe(404);
	});
});

describe("POST /workspaces/:workspaceId/pods", () => {
	it("creates one for an admin, and derives the slug from the name", async () => {
		const response = await app().request(
			`/workspaces/${WORKSPACE}/pods`,
			as("admin-token", json({ name: "Sales Team" })),
		);

		expect(response.status).toBe(201);
		expect(created).toEqual({ name: "Sales Team", slug: "sales-team" });
	});

	it("refuses a member", async () => {
		const response = await app().request(
			`/workspaces/${WORKSPACE}/pods`,
			as("member-token", json({ name: "Sales" })),
		);

		expect(response.status).toBe(403);
		expect(await errorTag(response)).toBe("Forbidden");
	});

	it("rejects a name nothing can be slugged from", async () => {
		const response = await app().request(
			`/workspaces/${WORKSPACE}/pods`,
			as("admin-token", json({ name: "!!!" })),
		);

		expect(response.status).toBe(400);
		expect(created).toBeUndefined();
	});

	it("rejects a body that is not a pod, with the field issues", async () => {
		const response = await app().request(
			`/workspaces/${WORKSPACE}/pods`,
			as("admin-token", json({ name: "" })),
		);

		expect(response.status).toBe(400);
		expect(Schema.decodeUnknownSync(BadRequest)(await response.json()).details).toBeDefined();
	});

	it("reports a taken slug as a conflict", async () => {
		slugTaken = true;

		const response = await app().request(
			`/workspaces/${WORKSPACE}/pods`,
			as("admin-token", json({ name: "Suga-Team" })),
		);

		expect(response.status).toBe(409);
		expect(await errorTag(response)).toBe("Conflict");
	});
});

describe("reading one pod", () => {
	it("is visible to a member of it, with what they may do in it", async () => {
		const response = await app().request(`/pods/${POD}`, as("member-token"));

		expect(response.status).toBe(200);
		const seen = Schema.decodeUnknownSync(podSchema)(await response.json());
		expect(seen.slug).toBe("suga-team");
		expect(seen.permissions).toEqual({
			rename: false,
			changeRouting: false,
			manageMembers: false,
			createAgents: true,
			updateAgents: true,
			deleteAgents: false,
			manageConnections: false,
			manageRoutines: false,
			runRoutines: false,
		});
	});

	it("is visible to an admin who is not in it", async () => {
		const response = await app().request(`/pods/${POD}`, as("admin-token"));

		expect(response.status).toBe(200);
		expect(Schema.decodeUnknownSync(podSchema)(await response.json()).permissions.rename).toBe(
			true,
		);
	});

	it("is hidden from a member of the workspace who is not in it", async () => {
		expect((await app().request(`/pods/${POD}`, as("stranger-token"))).status).toBe(404);
	});

	it("is not visible to somebody outside the workspace", async () => {
		expect((await app().request(`/pods/${POD}`, as("outsider-token"))).status).toBe(404);
	});

	it("does not confirm that an unknown id exists", async () => {
		expect((await app().request(`/pods/${OTHER}`, as("admin-token"))).status).toBe(404);
	});

	it("hides another person's Personal pod from an admin", async () => {
		podKind = "personal";

		expect((await app().request(`/pods/${POD}`, as("admin-token"))).status).toBe(404);
	});
});

describe("changing a pod", () => {
	it("lets an admin rename a pod they are not in", async () => {
		const response = await app().request(
			`/pods/${POD}`,
			as("admin-token", { method: "PATCH", body: JSON.stringify({ name: "Platform" }) }),
		);

		expect(response.status).toBe(200);
		expect(Schema.decodeUnknownSync(podSchema)(await response.json()).name).toBe("Platform");
	});

	it("refuses a member, even one who can see it", async () => {
		const response = await app().request(
			`/pods/${POD}`,
			as("member-token", { method: "PATCH", body: JSON.stringify({ name: "Platform" }) }),
		);

		expect(response.status).toBe(403);
	});

	it("rejects a patch that changes nothing", async () => {
		const response = await app().request(
			`/pods/${POD}`,
			as("admin-token", { method: "PATCH", body: JSON.stringify({}) }),
		);

		expect(response.status).toBe(400);
	});

	it("reports the store's refusal to rename a Personal pod as a bad request", async () => {
		podKind = "personal";
		const response = await app().request(
			`/pods/${POD}`,
			as("member-token", { method: "PATCH", body: JSON.stringify({ name: "Mine" }) }),
		);

		expect(response.status).toBe(400);
		expect(updated).toBeUndefined();
	});

	it("deletes a pod even when it has history", async () => {
		const response = await app().request(`/pods/${POD}`, as("admin-token", { method: "DELETE" }));
		expect(response.status).toBe(204);
	});

	it("reports the store's refusal to delete a Personal pod as a bad request", async () => {
		podKind = "personal";

		const response = await app().request(`/pods/${POD}`, as("member-token", { method: "DELETE" }));

		expect(response.status).toBe(400);
	});
});

describe("pod membership", () => {
	it("refuses somebody outside the workspace", async () => {
		const response = await app().request(
			`/pods/${POD}/members`,
			as("admin-token", json({ userId: outsider.id })),
		);

		expect(response.status).toBe(400);
		expect(added).toEqual([]);
	});

	it("refuses a member adding people", async () => {
		const response = await app().request(
			`/pods/${POD}/members`,
			as("member-token", json({ userId: outsider.id })),
		);

		expect(response.status).toBe(403);
	});

	it("reports removing somebody who was not there", async () => {
		const response = await app().request(
			`/pods/${POD}/members/${outsider.id}`,
			as("admin-token", { method: "DELETE" }),
		);

		expect(response.status).toBe(404);
	});

	it("reports the store's refusal to staff a Personal pod as a bad request", async () => {
		podKind = "personal";

		const response = await app().request(
			`/pods/${POD}/members`,
			as("member-token", json({ userId: admin.id })),
		);

		expect(response.status).toBe(400);
		expect(added).toEqual([]);
	});
});
