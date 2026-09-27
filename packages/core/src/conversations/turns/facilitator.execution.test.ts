import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "../../database/database.ts";
import { ModelRequestFailed } from "./model.ts";

const mocks = vi.hoisted(() => ({
	queueTurn: vi.fn(),
	settleThread: vi.fn(),
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
	stream: () => Effect.fail(new ModelRequestFailed({ message: "provider unavailable" })),
};

const execution = (model: FacilitatorExecution["model"]): FacilitatorExecution => ({
	model,
	publishEvents: () => Effect.void,
	queueTurn: mocks.queueTurn,
	routines: { settleThread: mocks.settleThread },
});

describe("an attempt at facilitation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.scope = scope;
		mocks.queueTurn.mockReturnValue(Effect.void);
		mocks.settleThread.mockReturnValue(Effect.succeed(true));
	});

	it("queues the chosen agent's turn and settles the Routine", async () => {
		const outcome = await runWithoutDatabase(
			attemptFacilitation(request, 1, execution(answering("@host-agent"))),
		);

		expect(outcome).toBe("finished");
		expect(mocks.queueTurn).toHaveBeenCalledWith({
			threadId: request.threadId,
			agentId: hostAgentId,
			triggerMessageId: request.triggerMessageId,
			reason: "facilitator",
		});
		expect(mocks.settleThread).toHaveBeenCalledWith(request.threadId);
	});

	it("settles a Routine when the facilitator answers nobody", async () => {
		const outcome = await runWithoutDatabase(
			attemptFacilitation(request, 1, execution(answering("nobody"))),
		);

		expect(outcome).toBe("finished");
		expect(mocks.queueTurn).not.toHaveBeenCalled();
		expect(mocks.settleThread).toHaveBeenCalledWith(request.threadId);
	});

	it("does not ask the model for a Chat", async () => {
		mocks.scope = { ...scope, threadType: "chat" };
		const stream = vi.fn(answering("host-agent").stream);

		const outcome = await runWithoutDatabase(
			attemptFacilitation(request, 1, execution({ stream })),
		);

		expect(outcome).toBe("finished");
		expect(stream).not.toHaveBeenCalled();
		expect(mocks.queueTurn).not.toHaveBeenCalled();
	});

	it("asks to run again when an attempt before the last fails", async () => {
		const outcome = await runWithoutDatabase(
			attemptFacilitation(request, 2, execution(unavailable)),
		);

		expect(outcome).toBe("retry");
		expect(mocks.settleThread).not.toHaveBeenCalled();
	});

	it("settles a Routine as failed when the last attempt fails", async () => {
		const outcome = await runWithoutDatabase(
			attemptFacilitation(request, 3, execution(unavailable)),
		);

		expect(outcome).toBe("finished");
		expect(mocks.settleThread).toHaveBeenCalledWith(request.threadId, {
			state: "failed",
			error: "provider unavailable",
		});
	});
});

const runWithoutDatabase = <A, E>(effect: Effect.Effect<A, E, Database>) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provideService(Database, {
				execute: () => Effect.die(new Error("This test has no database")),
				transaction: (work) => work,
			}),
		),
	);

async function* chunks(...values: string[]): AsyncIterable<string> {
	for (const value of values) yield value;
}
