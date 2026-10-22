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
const QUOTED = "0199a3a0-0000-7000-8000-000000000701";

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

const startThread = (body: object) =>
	signedIn({ method: "POST", body: JSON.stringify({ id: MESSAGE, message: "Hi", ...body }) });

describe("starting a thread from a pod's chat", () => {
	it("hands on the bot and the message it quotes", async () => {
		let asked: Parameters<Chats.Interface["startThread"]>[0] | undefined;
		await app({
			startThread: (input) => {
				asked = input;
				return Effect.fail(new Chats.HostHasNoModel());
			},
		}).request(
			`/conversations/${CHAT}/threads`,
			startThread({ hostAgentId: BOT, replyTo: QUOTED }),
		);

		expect(asked).toMatchObject({
			podChatId: CHAT,
			messageId: MESSAGE,
			hostAgentId: BOT,
			replyTo: QUOTED,
		});
	});

	it("is a bad request with a bot that is not crew, and a conflict with one that has no model", async () => {
		const refusing = (failure: Chats.HostNotCrew | Chats.HostHasNoModel) =>
			app({ startThread: () => Effect.fail(failure) }).request(
				`/conversations/${CHAT}/threads`,
				startThread({ hostAgentId: BOT }),
			);

		expect((await refusing(new Chats.HostNotCrew())).status).toBe(400);
		expect((await refusing(new Chats.HostHasNoModel())).status).toBe(409);
	});
});

describe("changing a pod's chat", () => {
	it("is a conflict once the chat is archived, or when it is the pod's first", async () => {
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
