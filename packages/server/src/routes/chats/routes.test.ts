import { InvalidCursor } from "@sugabots/contracts/errors/chat-reads";
import { BotHasNoModel } from "@sugabots/contracts/errors/chats";
import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import type { InputOf } from "@sugabots/contracts/operations";
import { Operations } from "@sugabots/core/operations/registry";
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
 * How the chat routes answer what their operations refuse, over doubles of
 * them. Why each is refused is decided in core.
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

/** The app with `operations` as the only operations it has. */
const app = (operations: Partial<Operations.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveMember), unimplemented(Operations.Service, operations)),
	);

const signedIn = (init: RequestInit = {}) => ({
	...init,
	headers: { ...signedInWith("sam"), "content-type": "application/json" },
});

const startChat = (body: object = {}) =>
	signedIn({ method: "POST", body: JSON.stringify({ retryKey: MESSAGE, message: "Hi", ...body }) });

describe("starting a chat in a project", () => {
	it("hands on the project and the message, and no files, which can't be uploaded before it starts", async () => {
		let asked: InputOf<"chats.startProjectChat"> | undefined;
		await app({
			"chats.startProjectChat": (_principal, input) => {
				asked = input;
				return Effect.fail(new BotHasNoModel());
			},
		}).request(`/projects/${PROJECT}/chats`, startChat({ attachments: [UPLOAD] }));

		expect(asked).toEqual({ projectId: PROJECT, retryKey: MESSAGE, message: "Hi" });
	});

	it("is a conflict when a bot given the floor has no model, and not found in a project the member cannot see", async () => {
		const refusing = (failure: BotHasNoModel | ResourceHidden) =>
			app({ "chats.startProjectChat": () => Effect.fail(failure) }).request(
				`/projects/${PROJECT}/chats`,
				startChat(),
			);

		expect((await refusing(new BotHasNoModel())).status).toBe(409);
		expect((await refusing(new ResourceHidden({ resource: "project" }))).status).toBe(404);
	});
});

describe("a chat the member cannot see", () => {
	it("is not found, whatever is asked of it", async () => {
		const hidden = Effect.fail(new ResourceHidden({ resource: "chat" }));
		const routes = app({ "chats.setResolved": () => hidden, "chats.messages": () => hidden });

		expect(
			(await routes.request(`/chats/${CHAT}/resolved`, signedIn({ method: "PUT" }))).status,
		).toBe(404);
		expect((await routes.request(`/chats/${CHAT}/messages`, signedIn())).status).toBe(404);
	});
});

describe("resolving a chat", () => {
	it("marks it resolved, and reopens it, through the one operation", async () => {
		const asked: Array<InputOf<"chats.setResolved">> = [];
		const routes = app({
			"chats.setResolved": (_principal, input) => Effect.sync(() => void asked.push(input)),
		});

		expect(
			(await routes.request(`/chats/${CHAT}/resolved`, signedIn({ method: "PUT" }))).status,
		).toBe(204);
		expect(
			(await routes.request(`/chats/${CHAT}/resolved`, signedIn({ method: "DELETE" }))).status,
		).toBe(204);
		expect(asked).toEqual([
			{ chatId: CHAT, resolved: true },
			{ chatId: CHAT, resolved: false },
		]);
	});
});

describe("a page of a chat", () => {
	it("is a bad request with a cursor that is not one", async () => {
		const response = await app({
			"chats.messages": () => Effect.fail(new InvalidCursor()),
		}).request(`/chats/${CHAT}/messages?cursor=nonsense`, signedIn());

		expect(response.status).toBe(400);
	});
});

describe("interrupting a turn", () => {
	const TURN = "0199a3a0-0000-7000-8000-000000000801";

	it("interrupts the turn in the path, in the chat in the path, and answers once it is marked", async () => {
		const asked: Array<InputOf<"chats.interruptTurn">> = [];
		const routes = app({
			"chats.interruptTurn": (_principal, input) => Effect.sync(() => void asked.push(input)),
		});

		const response = await routes.request(
			`/chats/${CHAT}/turns/${TURN}/interrupt`,
			signedIn({ method: "POST" }),
		);

		expect(response.status).toBe(202);
		expect(asked).toEqual([{ chatId: CHAT, turnId: TURN }]);
	});

	it("is forbidden to a member who may not interrupt it", async () => {
		const routes = app({
			"chats.interruptTurn": () => Effect.fail(new ActionForbidden({ proof: "CanInterrupt" })),
		});

		const response = await routes.request(
			`/chats/${CHAT}/turns/${TURN}/interrupt`,
			signedIn({ method: "POST" }),
		);

		expect(response.status).toBe(403);
	});
});
