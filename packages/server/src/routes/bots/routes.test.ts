import type { Bot } from "@sugabots/contracts";
import { BotNameTaken } from "@sugabots/contracts/errors/bots";
import { ModelNotEnabled } from "@sugabots/contracts/errors/providers";
import { Operations } from "@sugabots/core/operations/registry";
import type { Principal } from "@sugabots/core/principal";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { MemberResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy, signedInWith } from "../../http/app.test-support.ts";

/**
 * The bot routes, over doubles of the bots operations, so what is under test
 * is the routing, which principal each operation is called for, and what each
 * refusal means over HTTP. Who may do what to a bot is decided, and tested,
 * in core.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000101";
const BOT = "0199a3a0-0000-7000-8000-000000000201";
const MEMBER = "0199a3a0-0000-7000-8000-000000000002";
const MODEL = "gpt-4o-mini";

const bot: Bot = {
	id: BOT,
	workspaceId: WORKSPACE,
	name: "Triage",
	handle: "triage",
	description: null,
	color: "teal",
	eyes: "pill",
	shape: "circle",
	model: MODEL,
	instructions: "",
	disabledTools: [],
	usesComputer: false,
	naturalBrowsing: false,
	createdBy: null,
	visibility: "public",
	assistant: false,
	pinned: false,
	defaultProjectId: "0199a3a0-0000-7000-8000-0000000002b1",
	permissions: {
		update: true,
		delete: true,
		talk: true,
		resources: {
			readHistory: true,
			resolveChats: true,
			openSettings: true,
			deleteFiles: true,
			manageConnectors: true,
			manageComputer: true,
			useDesktop: true,
			manageAutomations: true,
			pauseAutomations: true,
			runAutomations: true,
		},
	},
	createdAt: "2026-09-10T00:00:00.000Z",
};

const resolveMember: MemberResolver = async () => ({
	id: MEMBER,
	name: "Sam",
	email: "sam@example.com",
	image: null,
});

/** The app with `operations` as the only operations it has. */
const app = (operations: Partial<Operations.Interface> = {}) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveMember), unimplemented(Operations.Service, operations)),
	);

/** The member a principal is signed in as, as the session authenticator built it. */
const memberOf = (principal: Principal) =>
	principal._tag === "MemberSession" ? principal.member : undefined;

const auth = (body?: unknown): RequestInit => ({
	method: body === undefined ? "GET" : "POST",
	headers: {
		...signedInWith("sam"),
		...(body === undefined ? {} : { "content-type": "application/json" }),
	},
	body: body === undefined ? undefined : JSON.stringify(body),
});

describe("bot routes", () => {
	it("lists the bots in the workspace in the path", async () => {
		let asked: unknown;
		const response = await app({
			"bots.list": (_principal, input) => {
				asked = input;
				return Effect.succeed([bot]);
			},
		}).request(`/workspaces/${WORKSPACE}/bots`, auth());

		expect(response.status).toBe(200);
		expect(asked).toEqual({ workspace: WORKSPACE });
		expect(await response.json()).toEqual([bot]);
	});

	it("creates a bot in the workspace it is posted to, as the member asking", async () => {
		let created: unknown;
		const response = await app({
			"bots.create": (principal, input) =>
				Effect.sync(() => {
					created = { ...input, memberId: memberOf(principal) };
					return bot;
				}),
		}).request(`/workspaces/${WORKSPACE}/bots`, auth({ name: "Writer", model: MODEL }));

		expect(response.status).toBe(201);
		expect(created).toEqual({
			workspace: WORKSPACE,
			name: "Writer",
			model: MODEL,
			memberId: MEMBER,
		});
	});

	it("reports a model the workspace does not offer as a bad request", async () => {
		const error = new ModelNotEnabled({ model: "disabled" });
		const response = await app({
			"bots.create": () => Effect.fail(error),
		}).request(`/workspaces/${WORKSPACE}/bots`, auth({ name: "Writer", model: "disabled" }));

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			_tag: "BadRequest",
			message: error.userMessage,
			error: { _tag: "ModelNotEnabled", userMessage: error.userMessage, isRetryable: false },
		});
	});

	it("reports a name another bot in the workspace has as a conflict", async () => {
		const error = new BotNameTaken({ field: "name", value: "Triage" });
		const response = await app({
			"bots.create": () => Effect.fail(error),
		}).request(`/workspaces/${WORKSPACE}/bots`, auth({ name: "Triage", model: MODEL }));

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			_tag: "Conflict",
			message: error.userMessage,
			error: { _tag: "BotNameTaken", userMessage: error.userMessage, isRetryable: false },
		});
	});

	it("pins and unpins the bot in the path for the member asking", async () => {
		const asked: unknown[] = [];
		const pinning = (pinned: boolean) => (principal: Principal, input: { botId: string }) =>
			Effect.sync(() => {
				asked.push({ ...input, pinned, memberId: memberOf(principal) });
				return { ...bot, pinned };
			});
		const routes = app({ "bots.pin": pinning(true), "bots.unpin": pinning(false) });

		const pinned = await routes.request(`/bots/${BOT}/pin`, { ...auth(), method: "PUT" });
		const unpinned = await routes.request(`/bots/${BOT}/pin`, { ...auth(), method: "DELETE" });

		expect(pinned.status).toBe(200);
		expect(await pinned.json()).toMatchObject({ pinned: true });
		expect(unpinned.status).toBe(200);
		expect(await unpinned.json()).toMatchObject({ pinned: false });
		expect(asked).toEqual([
			{ botId: BOT, pinned: true, memberId: MEMBER },
			{ botId: BOT, pinned: false, memberId: MEMBER },
		]);
	});

	it("returns the member's Personal Assistant in the workspace in the path", async () => {
		let asked: unknown;
		const response = await app({
			"bots.ensureAssistant": (_principal, input) =>
				Effect.sync(() => {
					asked = input;
					return { ...bot, assistant: true, visibility: "personal" as const };
				}),
		}).request(`/workspaces/${WORKSPACE}/assistant`, auth({ model: MODEL }));

		expect(response.status).toBe(200);
		expect(asked).toEqual({ workspace: WORKSPACE, model: MODEL });
		expect(await response.json()).toMatchObject({ assistant: true });
	});

	it("edits and deletes the bot in the path", async () => {
		const asked: unknown[] = [];
		const record = (input: unknown) =>
			Effect.sync(() => {
				asked.push(input);
			});
		const routes = app({
			"bots.update": (_principal, input) => Effect.as(record(input), bot),
			"bots.remove": (_principal, input) => record(input),
		});

		expect(
			(
				await routes.request(`/bots/${BOT}`, {
					...auth({ description: "Sorts the inbox" }),
					method: "PATCH",
				})
			).status,
		).toBe(200);
		expect((await routes.request(`/bots/${BOT}`, { ...auth(), method: "DELETE" })).status).toBe(
			204,
		);
		expect(asked).toEqual([
			{ botId: BOT, changes: { description: "Sorts the inbox" } },
			{ botId: BOT },
		]);
	});
});
