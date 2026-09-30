import type {
	ChatMessagesPage,
	ChatPageQuery,
	ThreadDetails,
	ThreadHistoryQuery,
} from "@sugabots/contracts";
import {
	OPENED_CHAT_PAGE_LIMIT,
	OPENED_CHAT_THREAD_MESSAGES,
	openedChatSchema,
} from "@sugabots/contracts";
import { ResourceHidden } from "@sugabots/core/authorization/access";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { ChatView } from "@sugabots/core/conversations/chats/chat-view";
import { Chats } from "@sugabots/core/conversations/chats/chats";
import { ThreadView } from "@sugabots/core/conversations/thread-view";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy } from "../../http/app.test-support.ts";

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const POD = "0199a3a0-0000-7000-8000-000000000002";
const AGENT = "0199a3a0-0000-7000-8000-000000000003";
const CHAT = "0199a3a0-0000-7000-8000-000000000004";
const THREAD = "0199a3a0-0000-7000-8000-000000000005";
const USER = "0199a3a0-0000-7000-8000-000000000006";

const resolveUser: UserResolver = async (headers) =>
	headers.get("authorization") === "Bearer member-token"
		? { id: USER, name: "Sam", email: "sam@example.com", image: null }
		: null;

const chat = {
	id: CHAT,
	workspaceId: WORKSPACE,
	podId: POD,
	hostAgentId: AGENT,
	mainThreadId: THREAD,
	createdAt: "2026-09-10T04:00:00.000Z",
	updatedAt: "2026-09-10T04:00:00.000Z",
};

const mainThread: ThreadDetails = {
	thread: {
		id: THREAD,
		workspaceId: WORKSPACE,
		podId: POD,
		hostAgentId: AGENT,
		chatId: CHAT,
		type: "chat",
		title: "Chat",
		status: "done",
		parentThreadId: null,
		initiatorUserId: USER,
		createdAt: chat.createdAt,
		updatedAt: chat.updatedAt,
	},
	routineExecution: null,
	crew: [],
	participants: [],
	messages: [],
	olderMessagesCursor: null,
};

const firstPage: ChatMessagesPage = { items: [], nextCursor: null };

let threadAskedFor: ThreadHistoryQuery | undefined;
let pageAskedFor: ChatPageQuery | undefined;

beforeEach(() => {
	threadAskedFor = undefined;
	pageAskedFor = undefined;
});

const seenBySam = <A>(value: A) =>
	Effect.flatMap(CurrentActor.Service, ({ userId }) =>
		userId === USER ? Effect.succeed(value) : Effect.fail(new ResourceHidden({ resource: "chat" })),
	);

const app = () =>
	createTestApp(
		Layer.mergeAll(
			identifiedBy(resolveUser),
			unimplemented(Chats.Service, { open: () => seenBySam(chat) }),
			unimplemented(ChatView.Service, {
				messages: (_chatId, page) => {
					pageAskedFor = page;
					return seenBySam(firstPage);
				},
			}),
			unimplemented(ThreadView.Service, {
				get: (_threadId, history) => {
					threadAskedFor = history;
					return seenBySam(mainThread);
				},
			}),
		),
	);

describe("chat routes", () => {
	it("opens a chat with its main thread's latest messages and its first page", async () => {
		const response = await app().request(`/workspaces/${WORKSPACE}/chats`, {
			method: "POST",
			headers: { authorization: "Bearer member-token", "content-type": "application/json" },
			body: JSON.stringify({ podId: POD, hostAgentId: AGENT }),
		});

		expect(response.status).toBe(200);
		expect(Schema.decodeUnknownSync(openedChatSchema)(await response.json())).toEqual({
			chat,
			mainThread,
			firstPage,
		});
		expect(threadAskedFor).toEqual({ limit: OPENED_CHAT_THREAD_MESSAGES });
		expect(pageAskedFor).toEqual({ limit: OPENED_CHAT_PAGE_LIMIT });
	});
});
