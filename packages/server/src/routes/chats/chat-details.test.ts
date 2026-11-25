import type { ChatDetails } from "@sugabots/contracts";
import { chatContextSchema, chatDetailsSchema } from "@sugabots/contracts";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import type { InputOf } from "@sugabots/contracts/operations";
import { testMember } from "@sugabots/contracts/testing";
import { Operations } from "@sugabots/core/operations/registry";
import type { Principal } from "@sugabots/core/principal";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import type { MemberResolver } from "../../http/app.test-support.ts";
import {
	createTestApp,
	identifiedBy,
	sessionTokenIn,
	signedInWith,
} from "../../http/app.test-support.ts";

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const BOT = "0199a3a0-0000-7000-8000-000000000003";
const CHAT = "0199a3a0-0000-7000-8000-000000000004";
const USER = "0199a3a0-0000-7000-8000-000000000005";
const resolveMember: MemberResolver = async (headers) =>
	sessionTokenIn(headers) === "sam-token"
		? { id: USER, name: "Sam", email: "sam@example.com", image: null }
		: null;

const chat = {
	id: CHAT,
	workspaceId: WORKSPACE,
	projectId: null,
	botId: BOT,
	rootChatId: CHAT,
	kind: "project_chat" as const,
	title: "Check the release",
	working: true,
	resolvedAt: null,
	createdAt: "2026-09-10T04:00:00.000Z",
	updatedAt: "2026-09-10T04:00:00.000Z",
};

const details: ChatDetails = {
	chat,
	automationRun: null,
	projectBots: [],
	membersReachingProject: [],
	participants: [
		testMember({ id: USER, name: "Sam" }),
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
			author: testMember({ id: USER, name: "Sam" }),
			status: "complete",
			parts: [{ type: "text", text: "Check the release" }],
			content: "Check the release",
			createdAt: chat.createdAt,
		},
	],
};

/**
 * Answers as the operation would for Sam, who can see `CHAT`, and hides
 * everything from anybody else, so a case can tell who it was called for.
 */
const seenBy = <A>(principal: Principal, chatId: string, seen: A) =>
	chatId === CHAT && principal._tag === "MemberSession" && principal.member === USER
		? Effect.succeed(seen)
		: Effect.fail(new ResourceHidden({ resource: "chat" }));

let reacted: Array<{ change: "add" | "remove"; messageId: string; emoji: string }>;
let requestedHistory: Omit<InputOf<"chats.get">, "chatId"> | undefined;

beforeEach(() => {
	reacted = [];
	requestedHistory = undefined;
});

const app = () =>
	createTestApp(
		Layer.mergeAll(
			identifiedBy(resolveMember),
			unimplemented(Operations.Service, {
				"chats.get": (principal, { chatId, ...history }) => {
					requestedHistory = history;
					return seenBy(principal, chatId, details);
				},
				"chats.context": (principal, { chatId }) => seenBy(principal, chatId, null),
				"chats.react": (_principal, { messageId, emoji }) => {
					reacted.push({ change: "add", messageId, emoji });
					return Effect.succeed([
						{ emoji, members: [{ id: USER, name: "Sam", at: chat.createdAt }] },
					]);
				},
				"chats.unreact": (_principal, { messageId, emoji }) => {
					reacted.push({ change: "remove", messageId, emoji });
					return Effect.succeed([]);
				},
			}),
		),
	);

const as = (token: string, init: RequestInit = {}) => ({
	...init,
	headers: { ...signedInWith(token), "content-type": "application/json" },
});

describe("chat routes", () => {
	it("returns chat history for the signed-in member", async () => {
		const response = await app().request(`/chats/${CHAT}`, as("sam-token"));
		expect(Schema.decodeUnknownSync(chatDetailsSchema)(await response.json())).toEqual(details);
		expect(requestedHistory).toEqual({ limit: 50 });
	});

	it("returns a chat's context for the signed-in member", async () => {
		const response = await app().request(`/chats/${CHAT}/context`, as("sam-token"));
		expect(Schema.decodeUnknownSync(Schema.NullOr(chatContextSchema))(await response.json())).toBe(
			null,
		);
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
			{ emoji: "👍🏽", members: [{ id: USER, name: "Sam", at: chat.createdAt }] },
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
