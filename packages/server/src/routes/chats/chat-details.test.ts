import type { ChatDetails } from "@sugabots/contracts";
import { chatContextSchema, chatDetailsSchema } from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { ResourceHidden } from "@sugabots/core/authorization/access";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { ChatDetailsView } from "@sugabots/core/chats/chat-details-view";
import { Reactions } from "@sugabots/core/chats/reactions/reactions";
import { Effect, Layer, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import type { PersonResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy } from "../../http/app.test-support.ts";

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const BOT = "0199a3a0-0000-7000-8000-000000000003";
const CHAT = "0199a3a0-0000-7000-8000-000000000004";
const USER = "0199a3a0-0000-7000-8000-000000000005";
const OUTSIDER = "0199a3a0-0000-7000-8000-000000000006";

const people = {
	"sam-token": { id: USER, name: "Sam", email: "sam@example.com", image: null },
	"outsider-token": { id: OUTSIDER, name: "Kim", email: "kim@example.com", image: null },
};

const resolvePerson: PersonResolver = async (headers) => {
	const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
	const signedIn = people[token as keyof typeof people];
	return signedIn ?? null;
};

const chat = {
	id: CHAT,
	workspaceId: WORKSPACE,
	projectId: null,
	botId: BOT,
	rootChatId: CHAT,
	kind: "project_chat" as const,
	title: "Check the release",
	status: "running" as const,
	parentChatId: null,
	resolvedAt: null,
	createdAt: "2026-09-10T04:00:00.000Z",
	updatedAt: "2026-09-10T04:00:00.000Z",
};

const details: ChatDetails = {
	chat,
	automationRun: null,
	projectBots: [],
	peopleReachingProject: [],
	participants: [
		testPerson({ id: USER, name: "Sam" }),
		{
			kind: "bot",
			id: BOT,
			name: "Release Bot",
			handle: "release-bot",
			color: "green",
			eyes: "pill",
			shape: "circle",
		},
	],
	olderMessagesCursor: null,
	queuedSince: null,
	reads: [],
	messages: [
		{
			id: "0199a3a0-0000-7000-8000-000000000007",
			chatId: CHAT,
			author: testPerson({ id: USER, name: "Sam" }),
			kind: "text",
			status: "complete",
			parts: [{ type: "text", text: "Check the release" }],
			content: "Check the release",
			createdAt: chat.createdAt,
		},
	],
};

/**
 * Answers as the view would for Sam, who can see `CHAT`, and hides
 * everything from anybody else, so a case can tell who it was asked as.
 */
const seenBy = <A>(chatId: string, seen: A) =>
	Effect.flatMap(CurrentActor.Service, ({ personId }) =>
		chatId === CHAT && personId === USER
			? Effect.succeed(seen)
			: Effect.fail(new ResourceHidden({ resource: "chat" })),
	);

let view: ChatDetailsView.Interface;
let reacted: Array<{ change: "add" | "remove"; messageId: string; emoji: string }>;
let requestedHistory: Parameters<ChatDetailsView.Interface["get"]>[1] | undefined;

beforeEach(() => {
	reacted = [];
	requestedHistory = undefined;
	view = {
		get: (chatId, history) => {
			requestedHistory = history;
			return seenBy(chatId, details);
		},
		context: (chatId) => seenBy(chatId, null),
	};
});

const app = () =>
	createTestApp(
		Layer.mergeAll(
			identifiedBy(resolvePerson),
			Layer.succeed(ChatDetailsView.Service, view),
			Layer.succeed(Reactions.Service, {
				add: (messageId, emoji) => {
					reacted.push({ change: "add", messageId, emoji });
					return Effect.succeed([
						{ emoji, people: [{ id: USER, name: "Sam", at: chat.createdAt }] },
					]);
				},
				remove: (messageId, emoji) => {
					reacted.push({ change: "remove", messageId, emoji });
					return Effect.succeed([]);
				},
			}),
		),
	);

const as = (token: string, init: RequestInit = {}) => ({
	...init,
	headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
});

describe("chat routes", () => {
	it("returns scoped chat history and hides an unavailable id", async () => {
		const response = await app().request(`/chats/${CHAT}`, as("sam-token"));
		expect(Schema.decodeUnknownSync(chatDetailsSchema)(await response.json())).toEqual(details);
		expect(requestedHistory).toEqual({ limit: 50 });

		const hidden = await app().request(`/chats/${CHAT}`, as("outsider-token"));
		expect(hidden.status).toBe(404);
	});

	it("returns a visible chat's context and hides an unavailable id", async () => {
		const response = await app().request(`/chats/${CHAT}/context`, as("sam-token"));
		expect(Schema.decodeUnknownSync(Schema.NullOr(chatContextSchema))(await response.json())).toBe(
			null,
		);

		const hidden = await app().request(`/chats/${CHAT}/context`, as("outsider-token"));
		expect(hidden.status).toBe(404);
	});

	it("answers HEAD without loading a full history page", async () => {
		const get = await app().request(`/chats/${CHAT}`, as("sam-token"));
		const head = await app().request(`/chats/${CHAT}`, as("sam-token", { method: "HEAD" }));

		expect(head.status).toBe(get.status);
		expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
		expect(head.body).toBeNull();
		expect(requestedHistory).toEqual({ limit: 1 });
	});

	it("accepts a bounded history cursor and rejects limit boundaries", async () => {
		const cursor = "opaque-cursor";
		const response = await app().request(
			`/chats/${CHAT}?cursor=${cursor}&limit=100`,
			as("sam-token"),
		);

		expect(response.status).toBe(200);
		expect(requestedHistory).toEqual({ cursor, limit: 100 });
		expect((await app().request(`/chats/${CHAT}?limit=0`, as("sam-token"))).status).toBe(400);
		expect((await app().request(`/chats/${CHAT}?limit=101`, as("sam-token"))).status).toBe(400);
	});

	it("reacts with the emoji the address names, and only with one emoji", async () => {
		const message = details.messages[0]?.id;
		const thumbsUp = encodeURIComponent("👍🏽");

		const added = await app().request(
			`/messages/${message}/reactions/${thumbsUp}`,
			as("sam-token", { method: "PUT" }),
		);
		expect(added.status).toBe(200);
		expect(await added.json()).toEqual([
			{ emoji: "👍🏽", people: [{ id: USER, name: "Sam", at: chat.createdAt }] },
		]);
		const removed = await app().request(
			`/messages/${message}/reactions/${thumbsUp}`,
			as("sam-token", { method: "DELETE" }),
		);
		expect(await removed.json()).toEqual([]);
		expect(reacted).toEqual([
			{ change: "add", messageId: message, emoji: "👍🏽" },
			{ change: "remove", messageId: message, emoji: "👍🏽" },
		]);

		for (const notOneEmoji of ["ok", encodeURIComponent("👍👍")]) {
			const refused = await app().request(
				`/messages/${message}/reactions/${notOneEmoji}`,
				as("sam-token", { method: "PUT" }),
			);
			expect(refused.status).toBe(400);
		}
		expect(reacted).toHaveLength(2);
	});
});
