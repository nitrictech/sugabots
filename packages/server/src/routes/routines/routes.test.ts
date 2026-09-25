import type { RoutineStore } from "@sugabots/core/conversations/routines/store";
import { testAuthorization } from "@sugabots/core/workspaces/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../http/app.test-support.ts";
import { MAX_JSON_BODY_BYTES } from "../../http/validation.ts";

const ROUTINE_ID = "0199a3a0-0000-7000-8000-000000000001";
const OTHER_ROUTINE_ID = "0199a3a0-0000-7000-8000-000000000002";
const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000006";
const AGENT_ID = "0199a3a0-0000-7000-8000-000000000007";
const USER_ID = "0199a3a0-0000-7000-8000-000000000008";
const EXECUTION_ID = "0199a3a0-0000-7000-8000-000000000004";
const THREAD_ID = "0199a3a0-0000-7000-8000-000000000005";
const POD_ID = "0199a3a0-0000-7000-8000-000000000009";
const MEMBER_ID = "0199a3a0-0000-7000-8000-00000000000a";
const STRANGER_ID = "0199a3a0-0000-7000-8000-00000000000b";
function webhookApp() {
	const acceptTrigger = vi.fn<RoutineStore["acceptTrigger"]>(() =>
		Effect.succeed({ executionId: EXECUTION_ID, threadId: THREAD_ID, duplicate: false }),
	);
	const acceptWebhook = vi.fn<RoutineStore["acceptWebhook"]>((routineId, secret) =>
		Effect.succeed(
			routineId === ROUTINE_ID && secret === "good-secret"
				? { executionId: EXECUTION_ID, threadId: THREAD_ID, duplicate: false }
				: undefined,
		),
	);
	const routines: RoutineStore = {
		list: () => Effect.succeed([]),
		get: () => Effect.undefined,
		create: () => Effect.die("not used"),
		update: () => Effect.die("not used"),
		remove: () => Effect.void,
		acceptTrigger,
		listExecutions: () => Effect.undefined,
		claimNext: () => Effect.undefined,
		settleThread: () => Effect.succeed(false),
		reconcileRunning: () => Effect.void,
		processNextDue: () => Effect.undefined,
		rotateSecret: () => Effect.die("not used"),
		acceptWebhook,
	};
	return {
		app: createTestApp({ resolveSession: async () => null, stores: { routines } }),
		acceptTrigger,
		acceptWebhook,
		routines,
	};
}

function deliver(
	app: ReturnType<typeof webhookApp>["app"],
	options: {
		secret?: string;
		contentType?: string;
		idempotencyKey?: string;
		body?: string;
		routineId?: string;
	} = {},
) {
	const headers: Record<string, string> = {
		"content-type": options.contentType ?? "application/json",
	};
	if (options.secret) headers.authorization = `Bearer ${options.secret}`;
	if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
	return app.request(`/hooks/routines/${options.routineId ?? ROUTINE_ID}`, {
		method: "POST",
		headers,
		body: options.body ?? JSON.stringify({ orderId: 42 }),
	});
}

describe("Routine webhooks", () => {
	it("authenticates the secret and accepts JSON trigger data", async () => {
		const { app, acceptWebhook } = webhookApp();

		const response = await deliver(app, {
			secret: "good-secret",
			idempotencyKey: "delivery-1",
		});

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			executionId: EXECUTION_ID,
			duplicate: false,
		});
		expect(acceptWebhook).toHaveBeenCalledWith(
			ROUTINE_ID,
			"good-secret",
			expect.objectContaining({
				kind: "webhook",
				idempotencyKey: "delivery-1",
				payload: { orderId: 42 },
			}),
		);
	});

	it("does not reveal whether a Routine exists when authentication fails", async () => {
		const { app, acceptTrigger } = webhookApp();

		const missing = await deliver(app);
		const invalid = await deliver(app, { secret: "wrong-secret" });
		const unknown = await deliver(app, { secret: "good-secret", routineId: OTHER_ROUTINE_ID });
		const malformed = await deliver(app, { secret: "good-secret", routineId: "not-a-uuid" });

		expect(missing.status).toBe(401);
		expect(invalid.status).toBe(401);
		expect(unknown.status).toBe(401);
		expect(malformed.status).toBe(401);
		expect(await missing.json()).toEqual(await invalid.json());
		expect(await unknown.json()).toEqual(await malformed.json());
		expect(acceptTrigger).not.toHaveBeenCalled();
	});

	it("rejects non-JSON content before authenticating", async () => {
		const { app, acceptWebhook } = webhookApp();

		const response = await deliver(app, {
			secret: "good-secret",
			contentType: "text/plain",
		});

		expect(response.status).toBe(400);
		expect(acceptWebhook).not.toHaveBeenCalled();
	});

	it("rejects oversized JSON before accepting a trigger", async () => {
		const { app, acceptTrigger } = webhookApp();

		const response = await deliver(app, {
			secret: "good-secret",
			body: JSON.stringify({ payload: "x".repeat(MAX_JSON_BODY_BYTES) }),
		});

		expect(response.status).toBe(413);
		expect(acceptTrigger).not.toHaveBeenCalled();
	});

	it("rejects overlong idempotency keys before accepting a trigger", async () => {
		const { app, acceptTrigger } = webhookApp();

		const response = await deliver(app, {
			secret: "good-secret",
			idempotencyKey: "x".repeat(201),
		});

		expect(response.status).toBe(400);
		expect(acceptTrigger).not.toHaveBeenCalled();
	});
});

/** Ada administers the workspace from outside the pod; Sam is in it; Kim is not. */
const authorization = testAuthorization({
	id: WORKSPACE_ID,
	roles: { [USER_ID]: "admin", [MEMBER_ID]: "member", [STRANGER_ID]: "member" },
	pods: [{ id: POD_ID, kind: "shared", members: [MEMBER_ID] }],
	agents: [{ id: AGENT_ID, podId: POD_ID, name: "Alerts", handle: "alerts" }],
});

function historyApp(userId: string, listExecutions: RoutineStore["listExecutions"]) {
	const base = webhookApp();
	return createTestApp({
		resolveSession: async () => ({
			user: { id: userId, name: "Somebody", email: "somebody@example.com", image: null },
		}),
		authorization,
		stores: { routines: { ...base.routines, listExecutions } },
	});
}

const executionsFor = (userId: string, listExecutions: RoutineStore["listExecutions"]) =>
	historyApp(userId, listExecutions).request(
		`/agents/${AGENT_ID}/routines/${ROUTINE_ID}/executions`,
		{ headers: { authorization: "Bearer session" } },
	);

describe("Routine execution history", () => {
	it("shows an administrator the history of a pod they are not in", async () => {
		const listExecutions = vi.fn<RoutineStore["listExecutions"]>(() =>
			Effect.succeed({ items: [], nextCursor: null }),
		);

		const response = await executionsFor(USER_ID, listExecutions);

		expect(response.status).toBe(200);
		expect(listExecutions).toHaveBeenCalled();
	});

	it("shows a member of the pod its history", async () => {
		const listExecutions = vi.fn<RoutineStore["listExecutions"]>(() =>
			Effect.succeed({ items: [], nextCursor: null }),
		);

		const response = await executionsFor(MEMBER_ID, listExecutions);

		expect(response.status).toBe(200);
		expect(listExecutions).toHaveBeenCalled();
	});

	it("does not expose execution snapshots to a member outside the pod", async () => {
		const listExecutions = vi.fn<RoutineStore["listExecutions"]>(() =>
			Effect.succeed({ items: [], nextCursor: null }),
		);

		const response = await executionsFor(STRANGER_ID, listExecutions);

		expect(response.status).toBe(404);
		expect(listExecutions).not.toHaveBeenCalled();
	});

	it("refuses a member starting a Routine by hand", async () => {
		const acceptTrigger = vi.fn<RoutineStore["acceptTrigger"]>(() =>
			Effect.succeed({ executionId: EXECUTION_ID, threadId: THREAD_ID, duplicate: false }),
		);
		const base = webhookApp();
		const app = createTestApp({
			resolveSession: async () => ({
				user: { id: MEMBER_ID, name: "Sam", email: "sam@example.com", image: null },
			}),
			authorization,
			stores: { routines: { ...base.routines, acceptTrigger } },
		});

		const response = await app.request(`/agents/${AGENT_ID}/routines/${ROUTINE_ID}/run`, {
			method: "POST",
			headers: { authorization: "Bearer session", "content-type": "application/json" },
			body: JSON.stringify({ requestId: "0199a3a0-0000-7000-8000-0000000000c1" }),
		});

		expect(response.status).toBe(403);
		expect(acceptTrigger).not.toHaveBeenCalled();
	});
});
