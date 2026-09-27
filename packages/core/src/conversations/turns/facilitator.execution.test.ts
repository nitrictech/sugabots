import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "../../database/database.ts";
import { ModelRequestFailed } from "./model.ts";

const mocks = vi.hoisted(() => ({
	completeJob: vi.fn(),
	retryOrFailJob: vi.fn(),
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

vi.mock("../jobs/queue.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../jobs/queue.ts")>();
	return {
		...actual,
		completeJob: mocks.completeJob,
		retryOrFailJob: mocks.retryOrFailJob,
	};
});

import {
	type ClaimedFacilitation,
	type FacilitatorScope,
	runClaimedFacilitation,
} from "./facilitator.ts";

const claimed: ClaimedFacilitation = {
	id: "0199a3a0-0000-7000-8000-000000000020",
	threadId: "0199a3a0-0000-7000-8000-000000000001",
	payload: { triggerMessageId: "0199a3a0-0000-7000-8000-000000000006" },
	dedupeKey: "facilitate:0199a3a0-0000-7000-8000-000000000001",
	attempts: 3,
};

const scope: FacilitatorScope = {
	threadId: claimed.threadId,
	threadType: "routine",
	workspaceId: "0199a3a0-0000-7000-8000-000000000002",
	model: "small-model",
	hostHandle: "host-agent",
	routerEnabled: true,
	crew: [],
	people: [],
	recent: [],
};

describe("runClaimedFacilitation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.scope = scope;
		mocks.completeJob.mockReturnValue(Effect.void);
		mocks.retryOrFailJob.mockReturnValue(Effect.succeed(false));
		mocks.queueTurn.mockReturnValue(Effect.void);
	});

	it("settles a Routine when the facilitator completes with nobody", async () => {
		const settleThread = vi.fn(() => Effect.succeed(true));

		await runWithoutDatabase(
			runClaimedFacilitation(claimed, {
				model: {
					stream: () =>
						Effect.succeed({ text: chunks("nobody"), accounting: Effect.succeed({ usage: {} }) }),
				},
				publishEvents: () => Effect.void,
				queueTurn: mocks.queueTurn,
				routines: { settleThread },
			}),
		);

		expect(mocks.completeJob).toHaveBeenCalledWith(claimed.id);
		expect(settleThread).toHaveBeenCalledWith(claimed.threadId);
	});

	it("does not run an already queued facilitator job for a Chat", async () => {
		mocks.scope = { ...scope, threadType: "chat" };
		const stream = vi.fn(() =>
			Effect.succeed({ text: chunks("host-agent"), accounting: Effect.succeed({ usage: {} }) }),
		);

		await runWithoutDatabase(
			runClaimedFacilitation(claimed, {
				model: { stream },
				publishEvents: () => Effect.void,
				queueTurn: mocks.queueTurn,
			}),
		);

		expect(stream).not.toHaveBeenCalled();
		expect(mocks.queueTurn).not.toHaveBeenCalled();
		expect(mocks.completeJob).toHaveBeenCalledWith(claimed.id);
	});

	it("settles a Routine as failed when the facilitator exhausts its retries", async () => {
		const settleThread = vi.fn(() => Effect.succeed(true));

		await runWithoutDatabase(
			runClaimedFacilitation(claimed, {
				model: {
					stream: () => Effect.fail(new ModelRequestFailed({ message: "provider unavailable" })),
				},
				publishEvents: () => Effect.void,
				queueTurn: mocks.queueTurn,
				routines: { settleThread },
			}),
		);

		expect(mocks.retryOrFailJob).toHaveBeenCalledWith(claimed, "provider unavailable");
		expect(settleThread).toHaveBeenCalledWith(claimed.threadId, {
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
