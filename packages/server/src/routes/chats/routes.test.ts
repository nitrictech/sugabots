import { ResourceHidden } from "@sugabots/core/authorization/access";
import { ChatView } from "@sugabots/core/conversations/chats/chat-view";
import { Chats } from "@sugabots/core/conversations/chats/chats";
import { FloorControl } from "@sugabots/core/conversations/floor/floor-control";
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
const PROJECT = "0199a3a0-0000-7000-8000-000000000601";
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

const startThread = (body: object = {}) =>
	signedIn({ method: "POST", body: JSON.stringify({ id: MESSAGE, message: "Hi", ...body }) });

describe("starting a thread in a project", () => {
	it("hands on the project and the message, and no files, which can't be uploaded before it starts", async () => {
		let asked: Parameters<Chats.Interface["startProjectThread"]>[0] | undefined;
		await app({
			startProjectThread: (input) => {
				asked = input;
				return Effect.fail(new FloorControl.BotHasNoModel());
			},
		}).request(`/projects/${PROJECT}/threads`, startThread({ attachments: [UPLOAD] }));

		expect(asked).toEqual({ projectId: PROJECT, messageId: MESSAGE, content: "Hi" });
	});

	it("is a conflict when a bot given the floor has no model, and not found in a project the person cannot see", async () => {
		const refusing = (failure: FloorControl.BotHasNoModel | ResourceHidden) =>
			app({ startProjectThread: () => Effect.fail(failure) }).request(
				`/projects/${PROJECT}/threads`,
				startThread(),
			);

		expect((await refusing(new FloorControl.BotHasNoModel())).status).toBe(409);
		expect((await refusing(new ResourceHidden({ resource: "project" }))).status).toBe(404);
	});
});

describe("changing a project's thread", () => {
	it("is a conflict once the thread is archived", async () => {
		const archivedThread = app({ changeThread: () => Effect.fail(new Chats.ChatArchived()) });
		const renamed = await archivedThread.request(
			`/conversations/${CHAT}/name`,
			signedIn({ method: "PUT", body: JSON.stringify({ name: "Launch" }) }),
		);
		const archived = await archivedThread.request(
			`/conversations/${CHAT}/archived`,
			signedIn({ method: "PUT" }),
		);

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
