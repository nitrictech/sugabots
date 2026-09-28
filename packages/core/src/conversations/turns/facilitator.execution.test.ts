import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Database, transactional } from "../../database/database.ts";
import { ModelRequestFailed } from "./model.ts";

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
import {
	attemptFacilitation,
	type FacilitatorExecution,
	type FacilitatorScope,
} from "./facilitator.ts";

const request: FacilitateRequest = {
	threadId: "0199a3a0-0000-7000-8000-000000000001",
	triggerMessageId: "0199a3a0-0000-7000-8000-000000000006",
};

const hostAgentId = "0199a3a0-0000-7000-8000-000000000003";

const scope: FacilitatorScope = {
	threadId: request.threadId,
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

const answering = (answer: string): FacilitatorExecution["model"] => ({
	stream: () => Effect.succeed({ text: chunks(answer), accounting: Effect.succeed({ usage: {} }) }),
});

const unavailable: FacilitatorExecution["model"] = {
	stream: () =>
		Effect.fail(new ModelRequestFailed({ message: "provider unavailable", reason: "unavailable" })),
};

const execution = (model: FacilitatorExecution["model"]): FacilitatorExecution => ({
	model,
	emit: () => Effect.void,
	requests: { queueTurn: mocks.queueTurn },
});

describe("an attempt at facilitation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.scope = scope;
		mocks.queueTurn.mockReturnValue(Effect.void);
	});

	it("queues the chosen agent's turn", async () => {
		const outcome = await runWithoutDatabase(
			attemptFacilitation(request, 1, execution(answering("@host-agent"))),
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
		const outcome = await runWithoutDatabase(
			attemptFacilitation(request, 1, execution(answering("nobody"))),
		);

		expect(outcome).toBe("decided");
		expect(mocks.queueTurn).not.toHaveBeenCalled();
	});

	it("does not ask the model for a Chat", async () => {
		mocks.scope = { ...scope, threadType: "chat" };
		const stream = vi.fn(answering("host-agent").stream);

		const outcome = await runWithoutDatabase(
			attemptFacilitation(request, 1, execution({ stream })),
		);

		expect(outcome).toBe("decided");
		expect(stream).not.toHaveBeenCalled();
		expect(mocks.queueTurn).not.toHaveBeenCalled();
	});

	it("reports a failed attempt, having queued no turn", async () => {
		const outcome = await runWithoutDatabase(
			attemptFacilitation(request, 3, execution(unavailable)),
		);

		expect(outcome).toBe("failed");
		expect(mocks.queueTurn).not.toHaveBeenCalled();
	});
});

const runWithoutDatabase = <A, E>(effect: Effect.Effect<A, E, Database>) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provideService(Database, {
				execute: () => Effect.die(new Error("This test has no database")),
				transaction: transactional((work) => work),
			}),
		),
	);

async function* chunks(...values: string[]): AsyncIterable<string> {
	for (const value of values) yield value;
}
