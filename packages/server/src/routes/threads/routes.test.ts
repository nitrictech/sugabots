import type { ThreadDetails } from "@sugabots/contracts";
import { threadDetailsSchema, threadSchema } from "@sugabots/contracts";
import type { ThreadStore } from "@sugabots/core/conversations/threads/store";
import { testAuthorization } from "@sugabots/core/workspaces/testing";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionResolver } from "../../auth/session.ts";
import { createTestApp } from "../../http/app.test-support.ts";

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const POD = "0199a3a0-0000-7000-8000-000000000002";
const AGENT = "0199a3a0-0000-7000-8000-000000000003";
const THREAD = "0199a3a0-0000-7000-8000-000000000004";
const USER = "0199a3a0-0000-7000-8000-000000000005";
const OUTSIDER = "0199a3a0-0000-7000-8000-000000000006";

const people = {
	"member-token": { id: USER, name: "Sam", email: "sam@example.com", image: null },
	"outsider-token": { id: OUTSIDER, name: "Kim", email: "kim@example.com", image: null },
};

const resolveSession: SessionResolver = async (headers) => {
	const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
	const user = people[token as keyof typeof people];
	return user ? { user } : null;
};

const thread = {
	id: THREAD,
	workspaceId: WORKSPACE,
	podId: POD,
	hostAgentId: AGENT,
	chatId: null,
	type: "chat" as const,
	title: "Check the release",
	status: "running" as const,
	parentThreadId: null,
	initiatorUserId: USER,
	createdAt: "2026-09-10T04:00:00.000Z",
	updatedAt: "2026-09-10T04:00:00.000Z",
};

const details: ThreadDetails = {
	thread,
	activeTurnId: null,
	routineExecution: null,
	crew: [],
	summary: null,
	usage: {
		modelCalls: 0,
		inputTokens: null,
		outputTokens: null,
		totalTokens: null,
		reportedCost: null,
		latestContext: null,
	},
	participants: [
		{ kind: "person", id: USER, name: "Sam", handle: "sam", image: null },
		{
			kind: "agent",
			id: AGENT,
			name: "Release Agent",
			handle: "release-agent",
			hue: 150,
			face: "bar",
		},
	],
	olderMessagesCursor: null,
	messages: [
		{
			id: "0199a3a0-0000-7000-8000-000000000007",
			threadId: THREAD,
			author: { kind: "person", id: USER, name: "Sam", handle: "sam", image: null },
			kind: "text",
			status: "complete",
			parts: [{ type: "text", text: "Check the release" }],
			content: "Check the release",
			createdAt: thread.createdAt,
		},
	],
};

const authorization = testAuthorization({ id: WORKSPACE, roles: { [USER]: "member" } });

let store: ThreadStore;
let cancellation: { turnId: string; userId: string } | undefined;
let requestedHistory: Parameters<ThreadStore["getVisible"]>[2] | undefined;

beforeEach(() => {
	cancellation = undefined;
	requestedHistory = undefined;
	store = {
		listVisible: (_workspaceId, userId) => Effect.succeed(userId === USER ? [thread] : []),
		visibleThreadId: (threadId, userId) =>
			Effect.succeed(threadId === THREAD && userId === USER ? THREAD : undefined),
		getVisible: (threadId, userId, history) =>
			Effect.sync(() => {
				requestedHistory = history;
				return threadId === THREAD && userId === USER ? details : undefined;
			}),
	};
});

const app = () =>
	createTestApp({
		resolveSession,
		authorization,
		stores: {
			threads: store,
			turns: {
				requestCancel: (turnId, userId) =>
					Effect.sync(() => {
						cancellation = { turnId, userId };
						return turnId === THREAD && userId === USER;
					}),
			},
		},
	});

const as = (token: string, init: RequestInit = {}) => ({
	...init,
	headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
});

describe("thread routes", () => {
	it("lists only through a workspace membership", async () => {
		const response = await app().request(`/workspaces/${WORKSPACE}/threads`, as("member-token"));

		expect(response.status).toBe(200);
		expect(Schema.decodeUnknownSync(Schema.Array(threadSchema))(await response.json())).toEqual([
			thread,
		]);
		expect(
			(await app().request(`/workspaces/${WORKSPACE}/threads`, as("outsider-token"))).status,
		).toBe(404);
	});

	it("returns scoped thread history and hides an unavailable id", async () => {
		const response = await app().request(`/threads/${THREAD}`, as("member-token"));
		expect(Schema.decodeUnknownSync(threadDetailsSchema)(await response.json())).toEqual(details);
		expect(requestedHistory).toEqual({ limit: 50 });

		const hidden = await app().request(`/threads/${THREAD}`, as("outsider-token"));
		expect(hidden.status).toBe(404);
	});

	it("answers HEAD without loading a full history page", async () => {
		const get = await app().request(`/threads/${THREAD}`, as("member-token"));
		const head = await app().request(`/threads/${THREAD}`, as("member-token", { method: "HEAD" }));

		expect(head.status).toBe(get.status);
		expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
		expect(head.body).toBeNull();
		expect(requestedHistory).toEqual({ limit: 1 });
	});

	it("accepts a bounded history cursor and rejects limit boundaries", async () => {
		const cursor = "opaque-cursor";
		const response = await app().request(
			`/threads/${THREAD}?cursor=${cursor}&limit=100`,
			as("member-token"),
		);

		expect(response.status).toBe(200);
		expect(requestedHistory).toEqual({ cursor, limit: 100 });
		expect((await app().request(`/threads/${THREAD}?limit=0`, as("member-token"))).status).toBe(
			400,
		);
		expect((await app().request(`/threads/${THREAD}?limit=101`, as("member-token"))).status).toBe(
			400,
		);
	});

	it("requests cancellation only for a visible active turn", async () => {
		const accepted = await app().request(
			`/turns/${THREAD}/cancel`,
			as("member-token", { method: "POST" }),
		);
		expect(accepted.status).toBe(202);
		expect(cancellation).toEqual({ turnId: THREAD, userId: USER });

		const hidden = await app().request(
			`/turns/${AGENT}/cancel`,
			as("outsider-token", { method: "POST" }),
		);
		expect(hidden.status).toBe(404);
	});
});
