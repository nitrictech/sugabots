import { ResourceHidden } from "@sugabots/core/authorization/access";
import { ChatView } from "@sugabots/core/chats/chats/chat-view";
import { Chats } from "@sugabots/core/chats/chats/chats";
import { InvalidCursor } from "@sugabots/core/chats/cursor";
import { FloorControl } from "@sugabots/core/chats/floor/floor-control";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
	createTestApp,
	identifiedBy,
	type MemberResolver,
	signedInWith,
} from "../../http/app.test-support.ts";

/**
 * How the chat routes answer what `Chats` and `ChatView` refuse, over doubles
 * of both. Why each is refused is decided in core.
 */

const CHAT = "0199a3a0-0000-7000-8000-000000000401";
const MESSAGE = "0199a3a0-0000-7000-8000-000000000501";
const PROJECT = "0199a3a0-0000-7000-8000-000000000601";
const UPLOAD = "0199a3a0-0000-7000-8000-000000000701";

const resolveMember: MemberResolver = async () => ({
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Sam",
	email: "sam@example.com",
	image: null,
});

const app = (chats: Partial<Chats.Interface>, view: Partial<ChatView.Interface> = {}) =>
	createTestApp(
		Layer.mergeAll(
			identifiedBy(resolveMember),
			unimplemented(Chats.Service, chats),
			unimplemented(ChatView.Service, view),
		),
	);

const signedIn = (init: RequestInit = {}) => ({
	...init,
	headers: { ...signedInWith("sam"), "content-type": "application/json" },
});

const startChat = (body: object = {}) =>
	signedIn({ method: "POST", body: JSON.stringify({ id: MESSAGE, message: "Hi", ...body }) });

describe("starting a chat in a project", () => {
	it("hands on the project and the message, and no files, which can't be uploaded before it starts", async () => {
		let asked: Parameters<Chats.Interface["startProjectChat"]>[0] | undefined;
		await app({
			startProjectChat: (input) => {
				asked = input;
				return Effect.fail(new FloorControl.BotHasNoModel());
			},
		}).request(`/projects/${PROJECT}/chats`, startChat({ attachments: [UPLOAD] }));

		expect(asked).toEqual({ projectId: PROJECT, messageId: MESSAGE, content: "Hi" });
	});

	it("is a conflict when a bot given the floor has no model, and not found in a project the member cannot see", async () => {
		const refusing = (failure: FloorControl.BotHasNoModel | ResourceHidden) =>
			app({ startProjectChat: () => Effect.fail(failure) }).request(
				`/projects/${PROJECT}/chats`,
				startChat(),
			);

		expect((await refusing(new FloorControl.BotHasNoModel())).status).toBe(409);
		expect((await refusing(new ResourceHidden({ resource: "project" }))).status).toBe(404);
	});
});

describe("a chat the member cannot see", () => {
	it("is not found, whatever is asked of it", async () => {
		const hidden = Effect.fail(new ResourceHidden({ resource: "chat" }));
		const routes = app({ setResolved: () => hidden }, { messages: () => hidden });

		expect(
			(await routes.request(`/chats/${CHAT}/resolved`, signedIn({ method: "PUT" }))).status,
		).toBe(404);
		expect((await routes.request(`/chats/${CHAT}/messages`, signedIn())).status).toBe(404);
	});
});

describe("a page of a chat", () => {
	it("is a bad request with a cursor that is not one", async () => {
		const response = await app({}, { messages: () => Effect.fail(new InvalidCursor()) }).request(
			`/chats/${CHAT}/messages?cursor=nonsense`,
			signedIn(),
		);

		expect(response.status).toBe(400);
	});
});
