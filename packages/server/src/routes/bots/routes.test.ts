import type { Bot } from "@sugabots/contracts";
import { ActionForbidden, ResourceHidden } from "@sugabots/core/authorization/access";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { ModelProviderRepository } from "@sugabots/core/providers/model-providers/model-provider-repository";
import { unimplemented } from "@sugabots/core/testing";
import { BotAdministration } from "@sugabots/core/workspaces/bots/bot-administration";
import { BotRepository } from "@sugabots/core/workspaces/bots/bot-repository";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy } from "../../http/app.test-support.ts";

/**
 * The bot routes, over doubles of `BotAdministration`. Who may do what to
 * a bot is decided, and tested, in `bots/bot-administration.test.ts`.
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
	face: "pill",
	shape: "circle",
	model: MODEL,
	prompt: "",
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
			openSettings: true,
			deleteFiles: true,
			manageConnections: true,
			manageComputer: true,
			useDesktop: true,
			manageAutomations: true,
			runAutomations: true,
		},
	},
	createdAt: "2026-09-10T00:00:00.000Z",
};

const resolveUser: UserResolver = async () => ({
	id: MEMBER,
	name: "Sam",
	email: "sam@example.com",
	image: null,
});

/** The app with `bots` as the only bot methods it has. */
const app = (bots: Partial<BotAdministration.Interface> = {}) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveUser), unimplemented(BotAdministration.Service, bots)),
	);

const auth = (body?: unknown): RequestInit => ({
	method: body === undefined ? "GET" : "POST",
	headers: {
		authorization: "Bearer member",
		...(body === undefined ? {} : { "content-type": "application/json" }),
	},
	body: body === undefined ? undefined : JSON.stringify(body),
});

describe("bot routes", () => {
	it("lists the bots in the workspace in the path", async () => {
		let asked: unknown;
		const response = await app({
			list: (input) => {
				asked = input;
				return Effect.succeed([bot]);
			},
		}).request(`/workspaces/${WORKSPACE}/bots`, auth());

		expect(response.status).toBe(200);
		expect(asked).toEqual({ workspace: WORKSPACE });
		expect(await response.json()).toEqual([bot]);
	});

	it("creates a bot in the workspace it is posted to, as the person asking", async () => {
		let created: unknown;
		const response = await app({
			create: (input) =>
				Effect.map(CurrentActor.Service, ({ userId }) => {
					created = { ...input, userId };
					return bot;
				}),
		}).request(`/workspaces/${WORKSPACE}/bots`, auth({ name: "Writer", model: MODEL }));

		expect(response.status).toBe(201);
		expect(created).toEqual({
			workspace: WORKSPACE,
			bot: { name: "Writer", model: MODEL },
			userId: MEMBER,
		});
	});

	it("reports a model the workspace does not offer as a bad request", async () => {
		const response = await app({
			create: (input) =>
				Effect.fail(new ModelProviderRepository.ModelNotEnabled({ model: input.bot.model })),
		}).request(`/workspaces/${WORKSPACE}/bots`, auth({ name: "Writer", model: "disabled" }));

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			_tag: "BadRequest",
			message: "This workspace does not offer that model",
		});
	});

	it("reports a name another bot in the workspace has as a conflict", async () => {
		const response = await app({
			create: (input) =>
				Effect.fail(new BotRepository.BotNameTaken({ field: "name", value: input.bot.name })),
		}).request(`/workspaces/${WORKSPACE}/bots`, auth({ name: "Triage", model: MODEL }));

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			_tag: "Conflict",
			message: "Another bot in this workspace already has that name",
		});
	});

	it("pins and unpins the bot in the path for the person asking", async () => {
		const asked: unknown[] = [];
		const routes = app({
			setPinned: (input) =>
				Effect.map(CurrentActor.Service, ({ userId }) => {
					asked.push({ ...input, userId });
					return { ...bot, pinned: input.pinned };
				}),
		});

		const pinned = await routes.request(`/bots/${BOT}/pin`, { ...auth(), method: "PUT" });
		const unpinned = await routes.request(`/bots/${BOT}/pin`, { ...auth(), method: "DELETE" });

		expect(pinned.status).toBe(200);
		expect(await pinned.json()).toMatchObject({ pinned: true });
		expect(unpinned.status).toBe(200);
		expect(await unpinned.json()).toMatchObject({ pinned: false });
		expect(asked).toEqual([
			{ botId: BOT, pinned: true, userId: MEMBER },
			{ botId: BOT, pinned: false, userId: MEMBER },
		]);
	});

	it("returns the person's Personal Assistant in the workspace in the path", async () => {
		let asked: unknown;
		const response = await app({
			ensureAssistant: (input) =>
				Effect.sync(() => {
					asked = input;
					return { ...bot, assistant: true, visibility: "private" as const };
				}),
		}).request(`/workspaces/${WORKSPACE}/assistant`, auth({ model: MODEL }));

		expect(response.status).toBe(200);
		expect(asked).toEqual({ workspace: WORKSPACE, model: MODEL });
		expect(await response.json()).toMatchObject({ assistant: true });
	});

	it("reads, edits and deletes the bot in the path", async () => {
		const asked: unknown[] = [];
		const record = (input: unknown) =>
			Effect.sync(() => {
				asked.push(input);
			});
		const routes = app({
			get: (input) => Effect.as(record(input), bot),
			update: (input) => Effect.as(record(input), bot),
			remove: record,
		});

		expect((await routes.request(`/bots/${BOT}`, auth())).status).toBe(200);
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
			{ botId: BOT },
			{ botId: BOT, changes: { description: "Sorts the inbox" } },
			{ botId: BOT },
		]);
	});

	it("answers a bot hidden from the caller as not found", async () => {
		const response = await app({
			get: () => Effect.fail(new ResourceHidden({ resource: "bot" })),
		}).request(`/bots/${BOT}`, auth());

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ _tag: "NotFound", message: "No such bot" });
	});

	it("answers a change the caller may not make as forbidden", async () => {
		const response = await app({
			remove: () => Effect.fail(new ActionForbidden({ permission: "bot.delete" })),
		}).request(`/bots/${BOT}`, { ...auth(), method: "DELETE" });

		expect(response.status).toBe(403);
	});
});
