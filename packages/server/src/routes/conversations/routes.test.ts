import type { ConversationDetails } from "@sugabots/contracts";
import { conversationActivitySchema, conversationDetailsSchema } from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { ResourceHidden } from "@sugabots/core/authorization/access";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { ConversationView } from "@sugabots/core/conversations/conversation-view";
import { Reactions } from "@sugabots/core/conversations/reactions/reactions";
import { Effect, Layer, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy } from "../../http/app.test-support.ts";

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const BOT = "0199a3a0-0000-7000-8000-000000000003";
const THREAD = "0199a3a0-0000-7000-8000-000000000004";
const USER = "0199a3a0-0000-7000-8000-000000000005";
const OUTSIDER = "0199a3a0-0000-7000-8000-000000000006";

const people = {
	"member-token": { id: USER, name: "Sam", email: "sam@example.com", image: null },
	"outsider-token": { id: OUTSIDER, name: "Kim", email: "kim@example.com", image: null },
};

const resolveUser: UserResolver = async (headers) => {
	const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
	const user = people[token as keyof typeof people];
	return user ?? null;
};

const thread = {
	id: THREAD,
	workspaceId: WORKSPACE,
	projectId: null,
	botId: BOT,
	rootConversationId: THREAD,
	kind: "project_thread" as const,
	title: "Check the release",
	status: "running" as const,
	parentConversationId: null,
	doneAt: null,
	createdAt: "2026-09-10T04:00:00.000Z",
	updatedAt: "2026-09-10T04:00:00.000Z",
};

const details: ConversationDetails = {
	conversation: thread,
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
			face: "pill",
			shape: "circle",
		},
	],
	olderMessagesCursor: null,
	queuedSince: null,
	reads: [],
	messages: [
		{
			id: "0199a3a0-0000-7000-8000-000000000007",
			conversationId: THREAD,
			author: testPerson({ id: USER, name: "Sam" }),
			kind: "text",
			status: "complete",
			parts: [{ type: "text", text: "Check the release" }],
			content: "Check the release",
			createdAt: thread.createdAt,
		},
	],
};

/**
 * Answers as the view would for Sam, who can see `THREAD`, and hides
 * everything from anybody else, so a case can tell who it was asked as.
 */
const seenBy = <A>(conversationId: string, seen: A) =>
	Effect.flatMap(CurrentActor.Service, ({ userId }) =>
		conversationId === THREAD && userId === USER
			? Effect.succeed(seen)
			: Effect.fail(new ResourceHidden({ resource: "conversation" })),
	);

let view: ConversationView.Interface;
let reacted: Array<{ change: "add" | "remove"; messageId: string; emoji: string }>;
let requestedHistory: Parameters<ConversationView.Interface["get"]>[1] | undefined;

beforeEach(() => {
	reacted = [];
	requestedHistory = undefined;
	view = {
		get: (conversationId, history) => {
			requestedHistory = history;
			return seenBy(conversationId, details);
		},
		activity: (conversationId) =>
			seenBy(conversationId, {
				context: null,
			}),
	};
});

const app = () =>
	createTestApp(
		Layer.mergeAll(
			identifiedBy(resolveUser),
			Layer.succeed(ConversationView.Service, view),
			Layer.succeed(Reactions.Service, {
				add: (messageId, emoji) => {
					reacted.push({ change: "add", messageId, emoji });
					return Effect.succeed([
						{ emoji, people: [{ id: USER, name: "Sam", at: thread.createdAt }] },
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

describe("conversation routes", () => {
	it("returns scoped conversation history and hides an unavailable id", async () => {
		const response = await app().request(`/conversations/${THREAD}`, as("member-token"));
		expect(Schema.decodeUnknownSync(conversationDetailsSchema)(await response.json())).toEqual(
			details,
		);
		expect(requestedHistory).toEqual({ limit: 50 });

		const hidden = await app().request(`/conversations/${THREAD}`, as("outsider-token"));
		expect(hidden.status).toBe(404);
	});

	it("returns a visible conversation's activity and hides an unavailable id", async () => {
		const response = await app().request(`/conversations/${THREAD}/activity`, as("member-token"));
		expect(Schema.decodeUnknownSync(conversationActivitySchema)(await response.json())).toEqual({
			context: null,
		});

		const hidden = await app().request(`/conversations/${THREAD}/activity`, as("outsider-token"));
		expect(hidden.status).toBe(404);
	});

	it("answers HEAD without loading a full history page", async () => {
		const get = await app().request(`/conversations/${THREAD}`, as("member-token"));
		const head = await app().request(
			`/conversations/${THREAD}`,
			as("member-token", { method: "HEAD" }),
		);

		expect(head.status).toBe(get.status);
		expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
		expect(head.body).toBeNull();
		expect(requestedHistory).toEqual({ limit: 1 });
	});

	it("accepts a bounded history cursor and rejects limit boundaries", async () => {
		const cursor = "opaque-cursor";
		const response = await app().request(
			`/conversations/${THREAD}?cursor=${cursor}&limit=100`,
			as("member-token"),
		);

		expect(response.status).toBe(200);
		expect(requestedHistory).toEqual({ cursor, limit: 100 });
		expect(
			(await app().request(`/conversations/${THREAD}?limit=0`, as("member-token"))).status,
		).toBe(400);
		expect(
			(await app().request(`/conversations/${THREAD}?limit=101`, as("member-token"))).status,
		).toBe(400);
	});

	it("reacts with the emoji the address names, and only with one emoji", async () => {
		const message = details.messages[0]?.id;
		const thumbsUp = encodeURIComponent("👍🏽");

		const added = await app().request(
			`/messages/${message}/reactions/${thumbsUp}`,
			as("member-token", { method: "PUT" }),
		);
		expect(added.status).toBe(200);
		expect(await added.json()).toEqual([
			{ emoji: "👍🏽", people: [{ id: USER, name: "Sam", at: thread.createdAt }] },
		]);
		const removed = await app().request(
			`/messages/${message}/reactions/${thumbsUp}`,
			as("member-token", { method: "DELETE" }),
		);
		expect(await removed.json()).toEqual([]);
		expect(reacted).toEqual([
			{ change: "add", messageId: message, emoji: "👍🏽" },
			{ change: "remove", messageId: message, emoji: "👍🏽" },
		]);

		for (const notOneEmoji of ["ok", encodeURIComponent("👍👍")]) {
			const refused = await app().request(
				`/messages/${message}/reactions/${notOneEmoji}`,
				as("member-token", { method: "PUT" }),
			);
			expect(refused.status).toBe(400);
		}
		expect(reacted).toHaveLength(2);
	});
});
