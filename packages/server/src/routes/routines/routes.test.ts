import type { Routine } from "@sugabots/contracts";
import { ActionForbidden, ResourceHidden } from "@sugabots/core/authorization/access";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import {
	RoutineDeliveryIdTooLong,
	RoutineTriggerKindChanged,
	RoutineTriggerNotFound,
} from "@sugabots/core/conversations/routines/routine";
import { Routines } from "@sugabots/core/conversations/routines/routines";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createTestApp, identifiedBy } from "../../http/app.test-support.ts";
import { MAX_JSON_BODY_BYTES } from "../../http/validation.ts";

const ROUTINE_ID = "0199a3a0-0000-7000-8000-000000000001";
const TRIGGER_ID = "0199a3a0-0000-7000-8000-000000000003";
const OTHER_TRIGGER_ID = "0199a3a0-0000-7000-8000-000000000002";
const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000006";
const AGENT_ID = "0199a3a0-0000-7000-8000-000000000007";
const USER_ID = "0199a3a0-0000-7000-8000-000000000008";
const EXECUTION_ID = "0199a3a0-0000-7000-8000-000000000004";
const THREAD_ID = "0199a3a0-0000-7000-8000-000000000005";

const GOOD_AUTHORIZATION = "Bearer good-secret";

/**
 * The app with a webhook double that admits deliveries to `TRIGGER_ID` with
 * the good authorization, answers a `challenge` body with it, turns away an
 * `ignore` one, and refuses a `tooLong` one's id.
 */
function webhookApp() {
	const accept = vi.fn<Routines.WebhooksInterface["accept"]>(({ triggerId, delivery }) => {
		if (triggerId !== TRIGGER_ID || delivery.headers.authorization !== GOOD_AUTHORIZATION) {
			return Effect.succeed(undefined);
		}
		const payload = delivery.payload as { challenge?: string; tooLong?: boolean; ignore?: boolean };
		if (payload.tooLong) return Effect.fail(new RoutineDeliveryIdTooLong());
		if (payload.ignore) return Effect.succeed({ kind: "ignored" as const });
		if (payload.challenge) {
			return Effect.succeed({ kind: "challenge" as const, challenge: payload.challenge });
		}
		return Effect.succeed({
			kind: "run" as const,
			execution: { executionId: EXECUTION_ID, threadId: THREAD_ID, duplicate: false },
		});
	});
	return {
		app: createTestApp(unimplemented(Routines.Webhooks, { accept })),
		accept,
	};
}

function deliver(
	app: ReturnType<typeof webhookApp>["app"],
	options: {
		authorization?: string;
		contentType?: string;
		body?: string;
		path?: string;
	} = {},
) {
	const headers: Record<string, string> = {
		"content-type": options.contentType ?? "application/json",
	};
	if (options.authorization) headers.authorization = options.authorization;
	return app.request(options.path ?? `/hooks/triggers/${TRIGGER_ID}`, {
		method: "POST",
		headers,
		body: options.body ?? JSON.stringify({ orderId: 42 }),
	});
}

describe("Routine webhooks", () => {
	it("hands the trigger the delivery's headers, exact body and JSON", async () => {
		const { app, accept } = webhookApp();
		// Spacing a signature covers, which re-encoding the JSON would lose.
		const body = '{ "orderId":  42 }';

		const response = await deliver(app, { authorization: GOOD_AUTHORIZATION, body });

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ executionId: EXECUTION_ID, duplicate: false });
		const [input] = accept.mock.calls[0] ?? [];
		expect(input?.triggerId).toBe(TRIGGER_ID);
		expect(input?.delivery.headers.authorization).toBe(GOOD_AUTHORIZATION);
		expect(new TextDecoder().decode(input?.delivery.body)).toBe(body);
		expect(input?.delivery.payload).toEqual({ orderId: 42 });
	});

	// A routine's single webhook became a trigger with the routine's id, so its
	// callers' old address still reaches it.
	it("reaches a trigger with the routine's id at the routine's old address", async () => {
		const { app, accept } = webhookApp();

		const response = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			path: `/hooks/routines/${TRIGGER_ID}`,
		});

		expect(response.status).toBe(202);
		expect(accept.mock.calls[0]?.[0].triggerId).toBe(TRIGGER_ID);
	});

	it("answers Slack's URL check with its challenge", async () => {
		const { app } = webhookApp();

		const response = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			body: JSON.stringify({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
		});
	});

	it("answers a call the trigger's filter turned away with 200, so its sender does not retry", async () => {
		const { app } = webhookApp();

		const response = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			body: JSON.stringify({ ignore: true }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ignored: true });
	});

	it("does not reveal whether a Routine exists when authentication fails", async () => {
		const { app } = webhookApp();

		const missing = await deliver(app);
		const invalid = await deliver(app, { authorization: "Bearer wrong-secret" });
		const unknown = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			path: `/hooks/triggers/${OTHER_TRIGGER_ID}`,
		});

		expect([missing.status, invalid.status, unknown.status]).toEqual([401, 401, 401]);
		const [missingBody, invalidBody, unknownBody] = await Promise.all(
			[missing, invalid, unknown].map((response) => response.json()),
		);
		expect(missingBody).toEqual(invalidBody);
		expect(invalidBody).toEqual(unknownBody);
	});

	it("rejects non-JSON content before authenticating", async () => {
		const { app, accept } = webhookApp();

		const notJson = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			contentType: "text/plain",
		});
		const malformed = await deliver(app, { authorization: GOOD_AUTHORIZATION, body: "{" });

		expect(notJson.status).toBe(400);
		expect(malformed.status).toBe(400);
		expect(accept).not.toHaveBeenCalled();
	});

	it("rejects oversized JSON before accepting a trigger", async () => {
		const { app, accept } = webhookApp();

		const response = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			body: JSON.stringify({ payload: "x".repeat(MAX_JSON_BODY_BYTES) }),
		});

		expect(response.status).toBe(413);
		expect(accept).not.toHaveBeenCalled();
	});

	it("rejects a delivery whose id is too long", async () => {
		const { app } = webhookApp();

		const response = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			body: JSON.stringify({ tooLong: true }),
		});

		expect(response.status).toBe(400);
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

describe("a Routine's triggers", () => {
	const triggerPath = `/agents/${AGENT_ID}/routines/${ROUTINE_ID}/triggers/${TRIGGER_ID}`;

	it("changes the trigger in the path, as the person asking", async () => {
		const calls: Array<{ input: unknown; userId: string }> = [];
		const input = { kind: "webhook" as const, auth: { kind: "bearer" as const } };
		const response = await appAs({
			routines: {
				updateTrigger: (trigger, changed) =>
					Effect.as(asked(calls, { trigger, changed }), {
						routine: aRoutine(),
						secrets: [],
					}),
			},
		}).request(triggerPath, { method: "PUT", headers: session, body: JSON.stringify(input) });

		expect(response.status).toBe(200);
		expect(calls).toEqual([
			{
				input: {
					trigger: { agentId: AGENT_ID, routineId: ROUTINE_ID, triggerId: TRIGGER_ID },
					changed: input,
				},
				userId: USER_ID,
			},
		]);
	});

	it("refuses a change to a trigger's kind as a bad request", async () => {
		const response = await appAs({
			routines: { updateTrigger: () => Effect.fail(new RoutineTriggerKindChanged()) },
		}).request(triggerPath, {
			method: "PUT",
			headers: session,
			body: JSON.stringify({ kind: "webhook" }),
		});

		expect(response.status).toBe(400);
	});

	it("answers a trigger the routine does not have as not found", async () => {
		const response = await appAs({
			routines: { removeTrigger: () => Effect.fail(new RoutineTriggerNotFound()) },
		}).request(triggerPath, { method: "DELETE", headers: session });

		expect(response.status).toBe(404);
	});
});

function aRoutine(): Routine {
	return {
		id: ROUTINE_ID,
		workspaceId: WORKSPACE_ID,
		agentId: AGENT_ID,
		name: "Alerts",
		instructions: "Handle input.",
		triggers: [{ id: TRIGGER_ID, kind: "webhook", auth: { kind: "bearer" } }],
		state: "enabled",
		results: "keep_in_run",
		createdById: USER_ID,
		createdByAgentId: null,
		createdAt: "2026-10-15T00:00:00.000Z",
		updatedAt: "2026-10-15T00:00:00.000Z",
	};
}
