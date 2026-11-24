import type { Project } from "@sugabots/contracts";
import { projectSchema } from "@sugabots/contracts";
import { BadRequest, Conflict, Forbidden, NotFound } from "@sugabots/contracts/http";
import { ActionForbidden, ResourceHidden } from "@sugabots/core/authorization/access";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { projectPermissions } from "@sugabots/core/authorization/permissions";
import { unimplemented } from "@sugabots/core/testing";
import { ProjectAdministration } from "@sugabots/core/workspaces/projects/project-administration";
import { ProjectStore } from "@sugabots/core/workspaces/projects/project-store";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { MemberResolver } from "../../http/app.test-support.ts";
import {
	createTestApp,
	identifiedBy,
	sessionTokenIn,
	signedInWith,
} from "../../http/app.test-support.ts";

/**
 * The project routes, over doubles of `ProjectAdministration`, so what is under
 * test is the routing, who the administration is asked as, and what each
 * refusal means over HTTP. Who may do what is decided, and tested, in core.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const PROJECT = "0199a3a0-0000-7000-8000-0000000000a1";

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

const members = {
	"admin-token": admin,
	"outsider-token": outsider,
};

const resolveMember: MemberResolver = async (headers) => {
	const token = sessionTokenIn(headers) ?? "";
	const signedIn = members[token as keyof typeof members];
	return signedIn ?? null;
};

const BOT = "0199a3a0-0000-7000-8000-0000000000b1";

const projectFor = (memberId: string, isMember = true): Project => ({
	id: PROJECT,
	workspaceId: WORKSPACE,
	name: "Suga-Team",
	slug: "suga-team",
	color: "green",
	description: null,
	visibility: "public",
	leadBotId: BOT,
	isMember,
	permissions: projectPermissions(
		{ memberId, workspaceRole: "admin" },
		{ isMember, defaultOf: null, isPublic: true },
	),
	createdAt: "2026-09-09T00:00:00.000Z",
});

/** The app with `projects` as the only project methods it has. */
const app = (projects: Partial<ProjectAdministration.Interface>) =>
	createTestApp(
		Layer.merge(
			identifiedBy(resolveMember),
			unimplemented(ProjectAdministration.Service, projects),
		),
	);

const as = (token: string, init: RequestInit = {}) => ({
	...init,
	headers: {
		...signedInWith(token),
		"content-type": "application/json",
		...init.headers,
	},
});

const json = (value: unknown) => ({ method: "POST", body: JSON.stringify(value) });

const failure = Schema.Union([BadRequest, Conflict, Forbidden, NotFound]);

const errorTag = async (response: Response) =>
	Schema.decodeUnknownSync(failure)(await response.json())._tag;

describe("GET /workspaces/:workspace/projects", () => {
	it("lists the projects as the member the session belongs to sees them", async () => {
		let asked: unknown;
		const response = await app({
			list: (input) =>
				Effect.map(CurrentActor.Service, ({ memberId }) => {
					asked = { ...input, memberId };
					return [projectFor(memberId)];
				}),
		}).request(`/workspaces/${WORKSPACE}/projects`, as("admin-token"));

		expect(response.status).toBe(200);
		expect(asked).toEqual({ workspace: WORKSPACE, memberId: admin.id });
		expect(Schema.decodeUnknownSync(Schema.Array(projectSchema))(await response.json())).toEqual([
			projectFor(admin.id),
		]);
	});

	it("answers a workspace hidden from the caller as not found", async () => {
		const response = await app({
			list: () => Effect.fail(new ResourceHidden({ resource: "workspace" })),
		}).request(`/workspaces/${WORKSPACE}/projects`, as("outsider-token"));

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ _tag: "NotFound", message: "No such workspace" });
	});
});

describe("POST /workspaces/:workspace/projects", () => {
	it("creates one for an admin, leaving its address to be derived when none is given", async () => {
		let created: unknown;
		const response = await app({
			create: (input) => {
				created = { workspace: input.workspace, name: input.name, slug: input.slug };
				return Effect.succeed(projectFor(admin.id));
			},
		}).request(
			`/workspaces/${WORKSPACE}/projects`,
			as("admin-token", json({ name: "Sales Team", leadBotId: BOT })),
		);

		expect(response.status).toBe(201);
		expect(created).toEqual({ workspace: WORKSPACE, name: "Sales Team", slug: undefined });
	});

	it("answers an action the caller may not take as forbidden", async () => {
		const response = await app({
			create: () => Effect.fail(new ActionForbidden({ permission: "project.create" })),
		}).request(
			`/workspaces/${WORKSPACE}/projects`,
			as("admin-token", json({ name: "Sales", leadBotId: BOT })),
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			_tag: "Forbidden",
			message: "You are not allowed to do that",
		});
	});

	it("rejects a name nothing can be slugged from", async () => {
		const response = await app({
			create: () => Effect.fail(new ProjectAdministration.UnusableProjectName()),
		}).request(
			`/workspaces/${WORKSPACE}/projects`,
			as("admin-token", json({ name: "!!!", leadBotId: BOT })),
		);

		expect(response.status).toBe(400);
		expect(Schema.decodeUnknownSync(BadRequest)(await response.json()).message).toBe(
			"That name can't be a project's address. Choose another.",
		);
	});

	it("rejects a body that is not a project, with the field issues", async () => {
		const response = await app({}).request(
			`/workspaces/${WORKSPACE}/projects`,
			as("admin-token", json({ name: "", leadBotId: BOT })),
		);

		expect(response.status).toBe(400);
		expect(Schema.decodeUnknownSync(BadRequest)(await response.json()).details).toBeDefined();
	});

	it("reports a taken slug as a conflict", async () => {
		const response = await app({
			create: () => Effect.fail(new ProjectStore.ProjectSlugTaken({ slug: "suga-team" })),
		}).request(
			`/workspaces/${WORKSPACE}/projects`,
			as("admin-token", json({ name: "Suga-Team", leadBotId: BOT })),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			_tag: "Conflict",
			message: "A project with that address already exists in this workspace",
		});
	});
});

describe("changing a project", () => {
	it("renames the project in the path", async () => {
		const response = await app({
			update: ({ projectId, changes }) =>
				Effect.succeed({ ...projectFor(admin.id), id: projectId, name: changes.name ?? "" }),
		}).request(
			`/projects/${PROJECT}`,
			as("admin-token", { method: "PATCH", body: JSON.stringify({ name: "Platform" }) }),
		);

		expect(response.status).toBe(200);
		expect(Schema.decodeUnknownSync(projectSchema)(await response.json()).name).toBe("Platform");
	});

	it("answers a project hidden from the caller as not found", async () => {
		const response = await app({
			update: () => Effect.fail(new ResourceHidden({ resource: "project" })),
		}).request(
			`/projects/${PROJECT}`,
			as("outsider-token", { method: "PATCH", body: JSON.stringify({ name: "Platform" }) }),
		);

		expect(response.status).toBe(404);
		expect(await errorTag(response)).toBe("NotFound");
	});

	it("reports a patch that changes nothing as a bad request", async () => {
		const response = await app({
			update: () => Effect.fail(new ProjectAdministration.EmptyProjectUpdate()),
		}).request(
			`/projects/${PROJECT}`,
			as("admin-token", { method: "PATCH", body: JSON.stringify({}) }),
		);

		expect(response.status).toBe(400);
	});

	it("deletes a project", async () => {
		const response = await app({ remove: () => Effect.void }).request(
			`/projects/${PROJECT}`,
			as("admin-token", { method: "DELETE" }),
		);
		expect(response.status).toBe(204);
	});
});

describe("project membership", () => {
	it("reports somebody outside the workspace as a bad request", async () => {
		const response = await app({
			addMember: () => Effect.fail(new ProjectAdministration.NotInWorkspace()),
		}).request(`/projects/${PROJECT}/members`, as("admin-token", json({ memberId: outsider.id })));

		expect(response.status).toBe(400);
	});

	it("reports removing somebody who was not there as not found", async () => {
		const response = await app({
			removeMember: () => Effect.fail(new ProjectAdministration.NotInProject()),
		}).request(
			`/projects/${PROJECT}/members/${outsider.id}`,
			as("admin-token", { method: "DELETE" }),
		);

		expect(response.status).toBe(404);
	});

	it("refuses taking an administrator out of a project", async () => {
		const response = await app({
			removeMember: () => Effect.fail(new ProjectAdministration.AdministratorInEveryProject()),
		}).request(`/projects/${PROJECT}/members/${admin.id}`, as("admin-token", { method: "DELETE" }));

		expect(response.status).toBe(400);
	});

	it("takes the member the session belongs to out of the project", async () => {
		let asked: unknown;
		const response = await app({
			leave: (input) =>
				Effect.map(CurrentActor.Service, ({ memberId }) => {
					asked = { ...input, memberId };
				}),
		}).request(`/projects/${PROJECT}/membership`, as("admin-token", { method: "DELETE" }));

		expect(response.status).toBe(204);
		expect(asked).toEqual({ projectId: PROJECT, memberId: admin.id });
	});

	it("puts the member the session belongs to in a public project", async () => {
		let asked: unknown;
		const response = await app({
			join: (input) =>
				Effect.map(CurrentActor.Service, ({ memberId }) => {
					asked = { ...input, memberId };
					return projectFor(memberId);
				}),
		}).request(`/projects/${PROJECT}/membership`, as("admin-token", { method: "PUT" }));

		expect(response.status).toBe(200);
		expect(asked).toEqual({ projectId: PROJECT, memberId: admin.id });
		expect(Schema.decodeUnknownSync(projectSchema)(await response.json()).isMember).toBe(true);
	});
});

describe("a project's bots", () => {
	it("adds and removes the bot named", async () => {
		const asked: unknown[] = [];
		const routes = app({
			addBot: (input) => Effect.sync(() => void asked.push({ add: input })),
			removeBot: (input) => Effect.sync(() => void asked.push({ remove: input })),
		});

		const added = await routes.request(
			`/projects/${PROJECT}/bots`,
			as("admin-token", json({ botId: BOT })),
		);
		const removed = await routes.request(
			`/projects/${PROJECT}/bots/${BOT}`,
			as("admin-token", { method: "DELETE" }),
		);

		expect(added.status).toBe(204);
		expect(removed.status).toBe(204);
		expect(asked).toEqual([
			{ add: { projectId: PROJECT, botId: BOT } },
			{ remove: { projectId: PROJECT, botId: BOT } },
		]);
	});

	it("reports adding a personal bot as a bad request", async () => {
		const response = await app({
			addBot: () => Effect.fail(new ProjectStore.BotNotPublic()),
		}).request(`/projects/${PROJECT}/bots`, as("admin-token", json({ botId: BOT })));

		expect(response.status).toBe(400);
		expect(Schema.decodeUnknownSync(BadRequest)(await response.json()).message).toBe(
			"Only a public bot can be added to a project",
		);
	});
});
