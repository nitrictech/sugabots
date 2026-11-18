import { ResourceHidden } from "@sugabots/core/authorization/access";
import { ChatView } from "@sugabots/core/conversations/chats/chat-view";
import { Chats } from "@sugabots/core/conversations/chats/chats";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { createTestApp, identifiedBy, type UserResolver } from "../../http/app.test-support.ts";

/**
 * How the chat routes answer what `Chats` and `ChatView` refuse, over doubles
 * of both. Why each is refused is decided in core.
 */

const CHAT = "0199a3a0-0000-7000-8000-000000000401";
const MESSAGE = "0199a3a0-0000-7000-8000-000000000501";
const BOT = "0199a3a0-0000-7000-8000-000000000601";
const UPLOAD = "0199a3a0-0000-7000-8000-000000000701";

const resolveUser: UserResolver = async () => ({
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Sam",
	email: "sam@example.com",
	image: null,
});

const app = (chats: Partial<Chats.Interface>, view: Partial<ChatView.Interface> = {}) =>
	createTestApp(
		Layer.mergeAll(
			identifiedBy(resolveUser),
			unimplemented(Chats.Service, chats),
			unimplemented(ChatView.Service, view),
		),
	);

const signedIn = (init: RequestInit = {}) => ({
	...init,
	headers: { authorization: "Bearer member", "content-type": "application/json" },
});

const startTask = (body: object = {}) =>
	signedIn({ method: "POST", body: JSON.stringify({ id: MESSAGE, message: "Hi", ...body }) });

describe("starting a task with a bot", () => {
	it("hands on the bot and the message, and no files, which can't be uploaded before it starts", async () => {
		let asked: Parameters<Chats.Interface["startTask"]>[0] | undefined;
		await app({
			startTask: (input) => {
				asked = input;
				return Effect.fail(new Chats.HostHasNoModel());
			},
		}).request(`/bots/${BOT}/tasks`, startTask({ attachments: [UPLOAD] }));

		expect(asked).toEqual({ botId: BOT, messageId: MESSAGE, content: "Hi" });
	});

	it("is a conflict with a bot that has no model, and not found with one the person cannot see", async () => {
		const refusing = (failure: Chats.HostHasNoModel | ResourceHidden) =>
			app({ startTask: () => Effect.fail(failure) }).request(`/bots/${BOT}/tasks`, startTask());

		expect((await refusing(new Chats.HostHasNoModel())).status).toBe(409);
		expect((await refusing(new ResourceHidden({ resource: "bot" }))).status).toBe(404);
	});
});

describe("changing a channel's thread", () => {
	it("is a conflict once the chat is archived, or when it is the channel's main chat", async () => {
		const renamed = await app({
			changeChat: () => Effect.fail(new Chats.ChatArchived()),
		}).request(
			`/conversations/${CHAT}/name`,
			signedIn({ method: "PUT", body: JSON.stringify({ name: "Launch" }) }),
		);
		const archived = await app({
			changeChat: () => Effect.fail(new Chats.FirstChatNotArchivable()),
		}).request(`/conversations/${CHAT}/archived`, signedIn({ method: "PUT" }));

		expect(renamed.status).toBe(409);
		expect(archived.status).toBe(409);
	});
});

describe("a conversation the person cannot see", () => {
	it("is not found, whatever is asked of it", async () => {
		const hidden = Effect.fail(new ResourceHidden({ resource: "conversation" }));
		const routes = app({ setDone: () => hidden }, { messages: () => hidden });

		expect(
			(await routes.request(`/conversations/${CHAT}/done`, signedIn({ method: "PUT" }))).status,
		).toBe(404);
		expect((await routes.request(`/conversations/${CHAT}/messages`, signedIn())).status).toBe(404);
	});
});

describe("a page of a conversation", () => {
	it("is a bad request with a cursor that is not one", async () => {
		const response = await app(
			{},
			{ messages: () => Effect.fail(new ChatView.InvalidPageCursor()) },
		).request(`/conversations/${CHAT}/messages?cursor=nonsense`, signedIn());

		expect(response.status).toBe(400);
	});
});
