import { InvalidCursor } from "@sugabots/contracts/errors/chat-reads";
import { BotHasNoModel } from "@sugabots/contracts/errors/chats";
import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Entrypoint, operationGroups, ServedOperation } from "@sugabots/contracts/http";
import { type OutputOf, operationContracts } from "@sugabots/contracts/operations";
import { testMember } from "@sugabots/contracts/testing";
import { Operations } from "@sugabots/core/operations/registry";
import { unimplemented } from "@sugabots/core/testing";
import type { DomainError } from "@sugabots/errors";
import { Context, Effect, Layer } from "effect";
import { HttpApi } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";
import { ServerApi } from "./api.ts";
import {
	createTestApp,
	identifiedBy,
	type MemberResolver,
	signedInWith,
} from "./app.test-support.ts";

/**
 * The one handler every operation offered over HTTP has, over doubles of the
 * operations: which endpoints there are, how a request becomes an operation's
 * input, and how what it returns or fails with is answered. What each
 * operation does, and who may do it, is decided and tested in core.
 */

const CHAT = "0199a3a0-0000-7000-8000-000000000401";
const MESSAGE = "0199a3a0-0000-7000-8000-000000000501";
const TURN = "0199a3a0-0000-7000-8000-000000000801";
const PROJECT = "0199a3a0-0000-7000-8000-000000000601";
const AUTOMATION = "0199a3a0-0000-7000-8000-000000000701";

const resolveMember: MemberResolver = async () => ({
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Sam",
	email: "sam@example.com",
	image: null,
});

/** The app with `operations` as the only operations it has, every other one dying if called. */
const app = (operations: Partial<Operations.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveMember), unimplemented(Operations.Service, operations)),
	);

const signedIn = (init: { method?: string; body?: object } = {}): RequestInit => ({
	method: init.method ?? "GET",
	headers: { ...signedInWith("sam"), "content-type": "application/json" },
	...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
});

/** The routes offered, as `<method> <path>`, keyed by `<group>.<endpoint>`. */
const offeredRoutes = Object.fromEntries(
	Object.values(operationContracts).flatMap(({ name, http }) =>
		http.kind === "offered" ? [[name, `${http.method} /api${http.path}`]] : [],
	),
);

describe("the endpoints of the operations offered over HTTP", () => {
	it("are one per operation offered, named for it at its method and path, and none for any other", () => {
		const derivedGroups = new Set<string>(operationGroups.map((group) => group.identifier));
		const served: Record<string, string> = {};
		HttpApi.reflect(ServerApi, {
			onGroup() {},
			onEndpoint({ group, endpoint }) {
				if (!derivedGroups.has(group.identifier)) return;
				served[`${group.identifier}.${endpoint.identifier}`] =
					`${endpoint.method} ${endpoint.path}`;
			},
		});

		expect(served).toEqual(offeredRoutes);
	});

	it("are the only endpoints serving an operation, with one more for each served at an endpoint of its own, so none serves one held back", () => {
		const derivedGroups = new Set<string>(operationGroups.map((group) => group.identifier));
		const servedOperations: Array<string> = [];
		const servedByEntrypoints: Array<string> = [];
		HttpApi.reflect(ServerApi, {
			onGroup() {},
			onEndpoint({ group, endpoint }) {
				const operation = derivedGroups.has(group.identifier)
					? `${group.identifier}.${endpoint.identifier}`
					: Context.getOrUndefined(endpoint.annotations, ServedOperation);
				if (operation === undefined) return;
				const isEntrypoint = Context.getOrUndefined(group.annotations, Entrypoint) !== undefined;
				(isEntrypoint ? servedByEntrypoints : servedOperations).push(operation);
			},
		});

		const servedOverHttp = Object.values(operationContracts)
			.filter(({ http }) => http.kind === "offered" || http.kind === "ownEndpoint")
			.map(({ name }) => name);
		expect(servedOperations.sort()).toEqual(servedOverHttp.sort());
		expect(servedByEntrypoints).toEqual([]);
	});

	it("each answer a request without a session as unauthorized, so each has a handler", async () => {
		const routes = createTestApp();
		const statuses = await Promise.all(
			Object.entries(offeredRoutes).map(async ([operation, route]) => {
				const [method = "", path = ""] = route.split(" ");
				const address = path.replace("/api", "").replaceAll(/:\w+/g, MESSAGE);
				return [operation, (await routes.request(address, { method })).status] as const;
			}),
		);

		expect(statuses.filter(([, status]) => status !== 401)).toEqual([]);
	});
});

describe("a request to an operation's endpoint", () => {
	it.each<{ case: string; path: string; init: RequestInit; operation: string; input: unknown }>([
		{
			case: "its path parameters and JSON body",
			path: `/chats/${CHAT}/messages`,
			init: signedIn({ method: "POST", body: { retryKey: MESSAGE, message: "Hi" } }),
			operation: "chats.send",
			input: { chatId: CHAT, retryKey: MESSAGE, message: "Hi" },
		},
		{
			case: "its path parameters and query, with the query's defaults",
			path: `/chats/${CHAT}?cursor=opaque`,
			init: signedIn(),
			operation: "chats.get",
			input: { chatId: CHAT, cursor: "opaque", limit: 50 },
		},
		{
			case: "a path parameter as the address encodes it",
			path: `/messages/${MESSAGE}/reactions/${encodeURIComponent("👍🏽")}`,
			init: signedIn({ method: "PUT" }),
			operation: "chats.react",
			input: { messageId: MESSAGE, emoji: "👍🏽" },
		},
		{
			case: "a body holding one of a union, with what it leaves out still left out",
			path: `/projects/${PROJECT}/automations/${AUTOMATION}/triggers`,
			init: signedIn({
				method: "POST",
				body: { trigger: { kind: "webhook", auth: { kind: "bearer" } } },
			}),
			operation: "automations.addTrigger",
			input: {
				projectId: PROJECT,
				automationId: AUTOMATION,
				trigger: { kind: "webhook", auth: { kind: "bearer" } },
			},
		},
		{
			case: "nothing, for an operation that takes nothing",
			path: "/notifications",
			init: signedIn(),
			operation: "notifications.settings",
			input: {},
		},
	])("is the operation's input: $case", async ({ path, init, operation, input }) => {
		const asked: unknown[] = [];
		await app({
			// Only the input is under test, so the double answers nothing.
			[operation]: (_principal: unknown, given: unknown) =>
				Effect.sync(() => void asked.push(given)).pipe(Effect.andThen(Effect.die("answered"))),
		}).request(path, init);

		expect(asked).toEqual([input]);
	});

	it.each<[string, string, { method: string; body?: object }]>([
		["a query outside its bounds", `/chats/${CHAT}?limit=0`, { method: "GET" }],
		[
			"a path parameter that isn't one emoji",
			`/messages/${MESSAGE}/reactions/ok`,
			{ method: "PUT" },
		],
		[
			"an input its contract's checks across fields refuse, such as a message with no text or file",
			`/chats/${CHAT}/messages`,
			{ method: "POST", body: { retryKey: MESSAGE, message: "" } },
		],
		[
			"a message of only spaces, which is no text once trimmed",
			`/chats/${CHAT}/messages`,
			{ method: "POST", body: { retryKey: MESSAGE, message: "   " } },
		],
	])(
		"is refused as a bad request, without calling the operation, for %s",
		async (_case, path, init) => {
			const response = await app({}).request(path, signedIn(init));

			expect(response.status).toBe(400);
		},
	);
});

describe("what an operation's endpoint answers", () => {
	it("is the operation's output, at the status its contract gives", async () => {
		const sent: OutputOf<"chats.send"> = {
			id: MESSAGE,
			chatId: CHAT,
			author: testMember({ id: "0199a3a0-0000-7000-8000-000000000002", name: "Sam" }),
			status: "complete",
			parts: [{ type: "text", text: "Hi" }],
			content: "Hi",
			createdAt: "2026-09-10T04:00:00.000Z",
		};
		const routes = app({
			"chats.send": () => Effect.succeed(sent),
			"chats.setResolved": () => Effect.void,
			"chats.interruptTurn": () => Effect.void,
		});

		const posted = await routes.request(
			`/chats/${CHAT}/messages`,
			signedIn({ method: "POST", body: { retryKey: MESSAGE, message: "Hi" } }),
		);
		const resolved = await routes.request(
			`/chats/${CHAT}/resolved`,
			signedIn({ method: "PUT", body: { resolved: true } }),
		);
		const interrupted = await routes.request(
			`/chats/${CHAT}/turns/${TURN}/interrupt`,
			signedIn({ method: "POST" }),
		);

		expect([posted.status, await posted.json()]).toEqual([201, sent]);
		expect([resolved.status, await resolved.text()]).toEqual([204, ""]);
		expect([interrupted.status, await interrupted.text()]).toEqual([202, ""]);
	});

	it.each<{
		failure: string;
		status: number;
		error: DomainError;
		operation: string;
		path: string;
		init: RequestInit;
	}>([
		{
			failure: "NotFound",
			status: 404,
			error: new ResourceHidden({ resource: "chat" }),
			operation: "chats.markRead",
			path: `/chats/${CHAT}/read`,
			init: signedIn({ method: "POST" }),
		},
		{
			failure: "Forbidden",
			status: 403,
			error: new ActionForbidden({ proof: "CanChangeChat" }),
			operation: "chats.markRead",
			path: `/chats/${CHAT}/read`,
			init: signedIn({ method: "POST" }),
		},
		{
			failure: "Conflict",
			status: 409,
			error: new BotHasNoModel(),
			operation: "chats.send",
			path: `/chats/${CHAT}/messages`,
			init: signedIn({ method: "POST", body: { retryKey: MESSAGE, message: "Hi" } }),
		},
		{
			failure: "BadRequest",
			status: 400,
			error: new InvalidCursor(),
			operation: "chats.messages",
			path: `/chats/${CHAT}/messages`,
			init: signedIn(),
		},
	])(
		"is $failure for $error._tag, carrying its public form",
		async ({ failure, status, error, operation, path, init }) => {
			const response = await app({ [operation]: () => Effect.fail(error) }).request(path, init);

			expect(response.status).toBe(status);
			expect(await response.json()).toEqual({
				_tag: failure,
				message: error.userMessage,
				error: { _tag: error._tag, userMessage: error.userMessage, isRetryable: error.isRetryable },
			});
		},
	);
});
