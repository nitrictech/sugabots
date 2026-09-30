import { ActionForbidden, ResourceHidden } from "@sugabots/core/authorization/access";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { Routines } from "@sugabots/core/conversations/routines/routines";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createTestApp, identifiedBy } from "../../http/app.test-support.ts";
import { MAX_JSON_BODY_BYTES } from "../../http/validation.ts";

const ROUTINE_ID = "0199a3a0-0000-7000-8000-000000000001";
const OTHER_ROUTINE_ID = "0199a3a0-0000-7000-8000-000000000002";
const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000006";
const AGENT_ID = "0199a3a0-0000-7000-8000-000000000007";
const USER_ID = "0199a3a0-0000-7000-8000-000000000008";
const EXECUTION_ID = "0199a3a0-0000-7000-8000-000000000004";
const THREAD_ID = "0199a3a0-0000-7000-8000-000000000005";

function webhookApp() {
	const accept = vi.fn<Routines.WebhooksInterface["accept"]>(({ routineId, secret }) =>
		Effect.succeed(
			routineId === ROUTINE_ID && Redacted.value(secret) === "good-secret"
				? { executionId: EXECUTION_ID, threadId: THREAD_ID, duplicate: false }
				: undefined,
		),
	);
	return {
		app: createTestApp(unimplemented(Routines.Webhooks, { accept })),
		accept,
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
		const { app, accept } = webhookApp();

		const response = await deliver(app, {
			secret: "good-secret",
			idempotencyKey: "delivery-1",
		});

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			executionId: EXECUTION_ID,
			duplicate: false,
		});
		const [delivery] = accept.mock.calls[0] ?? [];
		expect(delivery?.routineId).toBe(ROUTINE_ID);
		expect(delivery && Redacted.value(delivery.secret)).toBe("good-secret");
		expect(delivery?.trigger).toMatchObject({
			kind: "webhook",
			idempotencyKey: "delivery-1",
			payload: { orderId: 42 },
		});
	});

	it("does not reveal whether a Routine exists when authentication fails", async () => {
		const { app } = webhookApp();

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
	});

	it("rejects non-JSON content before authenticating", async () => {
		const { app, accept } = webhookApp();

		const response = await deliver(app, {
			secret: "good-secret",
			contentType: "text/plain",
		});

		expect(response.status).toBe(400);
		expect(accept).not.toHaveBeenCalled();
	});

	it("rejects oversized JSON before accepting a trigger", async () => {
		const { app, accept } = webhookApp();

		const response = await deliver(app, {
			secret: "good-secret",
			body: JSON.stringify({ payload: "x".repeat(MAX_JSON_BODY_BYTES) }),
		});

		expect(response.status).toBe(413);
		expect(accept).not.toHaveBeenCalled();
	});

	it("rejects overlong idempotency keys before accepting a trigger", async () => {
		const { app, accept } = webhookApp();

		const response = await deliver(app, {
			secret: "good-secret",
			idempotencyKey: "x".repeat(201),
		});

		expect(response.status).toBe(400);
		expect(accept).not.toHaveBeenCalled();
	});
});

/** The app as Ada, with `routines` and `view` as the only routine methods it has; both are `Routines.Service`. */
function appAs(
	services: { routines?: Partial<Routines.Interface>; view?: Partial<Routines.Interface> } = {},
) {
	return createTestApp(
		Layer.mergeAll(
			identifiedBy(async () => ({
				id: USER_ID,
				name: "Ada",
				email: "ada@example.com",
				image: null,
			})),
			unimplemented(Routines.Service, { ...services.routines, ...services.view }),
		),
	);
}

const session = { authorization: "Bearer session", "content-type": "application/json" };

/** The actor a double was called as, alongside what it was given. */
const asked = <Input>(calls: Array<{ input: Input; userId: string }>, input: Input) =>
	Effect.map(CurrentActor.Service, ({ userId }) => {
		calls.push({ input, userId });
	});

describe("a Routine's runs", () => {
	it("reads the history of the routine in the path, as the person asking", async () => {
		const calls: Array<{ input: unknown; userId: string }> = [];
		const response = await appAs({
			view: {
				listExecutions: (routine) =>
					Effect.as(asked(calls, routine), { items: [], nextCursor: null }),
			},
		}).request(`/agents/${AGENT_ID}/routines/${ROUTINE_ID}/executions`, { headers: session });

		expect(response.status).toBe(200);
		expect(calls).toEqual([
			{ input: { agentId: AGENT_ID, routineId: ROUTINE_ID }, userId: USER_ID },
		]);
	});

	it("answers a routine hidden from the caller as not found", async () => {
		const response = await appAs({
			view: { listExecutions: () => Effect.fail(new ResourceHidden({ resource: "agent" })) },
		}).request(`/agents/${AGENT_ID}/routines/${ROUTINE_ID}/executions`, { headers: session });

		expect(response.status).toBe(404);
	});

	it("starts a run by hand as the person asking", async () => {
		const calls: Array<{ input: unknown; userId: string }> = [];
		const requestId = "0199a3a0-0000-7000-8000-0000000000c1";
		const response = await appAs({
			routines: {
				run: (input) =>
					Effect.as(asked(calls, input), {
						executionId: EXECUTION_ID,
						threadId: THREAD_ID,
						duplicate: false,
					}),
			},
		}).request(`/agents/${AGENT_ID}/routines/${ROUTINE_ID}/run`, {
			method: "POST",
			headers: session,
			body: JSON.stringify({ requestId }),
		});

		expect(response.status).toBe(202);
		expect(calls).toEqual([
			{ input: { agentId: AGENT_ID, routineId: ROUTINE_ID, requestId }, userId: USER_ID },
		]);
	});

	it("answers a run the caller may not start as forbidden", async () => {
		const response = await appAs({
			routines: { run: () => Effect.fail(new ActionForbidden({ permission: "routine.run" })) },
		}).request(`/agents/${AGENT_ID}/routines/${ROUTINE_ID}/run`, {
			method: "POST",
			headers: session,
			body: JSON.stringify({ requestId: "0199a3a0-0000-7000-8000-0000000000c1" }),
		});

		expect(response.status).toBe(403);
	});
});

describe("the workspace's routines", () => {
	it("lists what the view finds in the workspace in the path", async () => {
		const listInWorkspace = vi.fn<Routines.Interface["listInWorkspace"]>(() => Effect.succeed([]));

		const response = await appAs({ view: { listInWorkspace } }).request(
			`/workspaces/${WORKSPACE_ID}/routines`,
			{ headers: session },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ items: [] });
		expect(listInWorkspace).toHaveBeenCalledWith(WORKSPACE_ID);
	});
});
