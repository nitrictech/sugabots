import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Database, transactional } from "../../database/database.ts";
import { unimplemented } from "../../testing.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { ModelRequestFailed, type TurnModel } from "./model.ts";
import { TurnRequests } from "./requests.ts";

const mocks = vi.hoisted(() => ({
	queueTurn: vi.fn(),
	scope: undefined as unknown,
}));

vi.mock("../../database/database.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../database/database.ts")>();
	return {
		...actual,
		query: vi.fn(() => Effect.succeed(mocks.scope)),
		transaction: <A, E, R>(work: Effect.Effect<A, E, R>) => work,
	};
});

import type { FacilitateRequest } from "./facilitate.workflow.ts";
import { attemptFacilitation, type FacilitatorScope } from "./facilitator.ts";

const request: FacilitateRequest = {
	threadId: "0199a3a0-0000-7000-8000-000000000001",
	triggerMessageId: "0199a3a0-0000-7000-8000-000000000006",
};

const hostAgentId = "0199a3a0-0000-7000-8000-000000000003";

const scope: FacilitatorScope = {
	threadId: request.threadId,
	podId: "0199a3a0-0000-7000-8000-000000000004",
	threadType: "routine",
	workspaceId: "0199a3a0-0000-7000-8000-000000000002",
	model: "small-model",
	hostHandle: "host-agent",
	routerEnabled: true,
	crew: [
		{ id: hostAgentId, name: "Host", handle: "host-agent", description: null, inThread: true },
	],
	people: [],
	recent: [],
};

const answering = (answer: string): TurnModel => ({
	stream: () => Effect.succeed({ text: chunks(answer), accounting: Effect.succeed({ usage: {} }) }),
});

const unavailable: TurnModel = {
	stream: () =>
		Effect.fail(new ModelRequestFailed({ message: "provider unavailable", reason: "unavailable" })),
};

describe("an attempt at facilitation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.scope = scope;
		mocks.queueTurn.mockReturnValue(Effect.void);
	});

	it("queues the chosen agent's turn", async () => {
		const outcome = await runWithoutDatabase(
			attemptFacilitation(request, 1, answering("@host-agent")),
		);

		expect(outcome).toBe("decided");
		expect(mocks.queueTurn).toHaveBeenCalledWith({
			threadId: request.threadId,
			agentId: hostAgentId,
			triggerMessageId: request.triggerMessageId,
			reason: "facilitator",
		});
	});

	it("queues no turn when the facilitator answers nobody", async () => {
		const outcome = await runWithoutDatabase(attemptFacilitation(request, 1, answering("nobody")));

		expect(outcome).toBe("decided");
		expect(mocks.queueTurn).not.toHaveBeenCalled();
	});

	it("does not ask the model for a Chat", async () => {
		mocks.scope = { ...scope, threadType: "chat" };
		const stream = vi.fn(answering("host-agent").stream);

		const outcome = await runWithoutDatabase(attemptFacilitation(request, 1, { stream }));

		expect(outcome).toBe("decided");
		expect(stream).not.toHaveBeenCalled();
		expect(mocks.queueTurn).not.toHaveBeenCalled();
	});

	it("leaves a defect to the workflow rather than reporting it as a failed attempt", async () => {
		mocks.queueTurn.mockReturnValue(Effect.die(new Error("database unavailable")));

		await expect(
			runWithoutDatabase(attemptFacilitation(request, 1, answering("@host-agent"))),
		).rejects.toThrow("database unavailable");
	});

	it("reports a failed attempt, having queued no turn", async () => {
		const outcome = await runWithoutDatabase(attemptFacilitation(request, 3, unavailable));

		expect(outcome).toBe("failed");
		expect(mocks.queueTurn).not.toHaveBeenCalled();
	});
});

/** Runs `effect` on services that bring agents in and queue turns without a database. */
const runWithoutDatabase = <A, E>(
	effect: Effect.Effect<A, E, Database | ThreadRepository.Service | TurnRequests.Service>,
) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(
				Layer.mergeAll(
					unimplemented(ThreadRepository.Service, { addAgents: () => Effect.void }),
					unimplemented(TurnRequests.Service, { queueTurn: mocks.queueTurn }),
				),
			),
			Effect.provideService(Database, {
				execute: () => Effect.die(new Error("This test has no database")),
				transaction: transactional((work) => work),
			}),
		),
	);

async function* chunks(...values: string[]): AsyncIterable<string> {
	for (const value of values) yield value;
}
