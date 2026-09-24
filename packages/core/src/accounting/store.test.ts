import {
	type AttemptIntent,
	completeUsageEvidence,
	verifyAccountingStoreContract,
} from "@sugabots/accounting";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { workspace } from "../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../database/testing.ts";
import { modelAttempt } from "./sql.ts";
import { modelAttemptStore } from "./store.ts";

describe.skipIf(!process.env.DATABASE_URL)("model attempt ledger, against Postgres", () => {
	const store = onPostgres(modelAttemptStore);

	afterAll(closeDatabase);

	const intentFor = (workspaceId: string): AttemptIntent => ({
		attemptId: crypto.randomUUID(),
		executionId: crypto.randomUUID(),
		startedAt: "2026-09-24T00:00:00.000Z",
		attribution: { workspaceId, activityPurpose: "agent-turn" },
		provider: { connectionId: crypto.randomUUID(), provider: "anthropic", requestedModel: "m" },
	});

	const dispatchOf = (intent: AttemptIntent) => ({
		observationId: `${intent.attemptId}:dispatched`,
		attemptId: intent.attemptId,
		observedAt: intent.startedAt,
		payload: { type: "dispatched" as const, dispatchedAt: intent.startedAt },
	});

	it("meets the accounting package's store contract", async () => {
		const intent = intentFor(crypto.randomUUID());
		await runOnPostgres(
			verifyAccountingStoreContract(modelAttemptStore, {
				intent,
				usageObservation: {
					observationId: `${intent.attemptId}:usage:response`,
					attemptId: intent.attemptId,
					observedAt: "2026-09-24T00:00:01.000Z",
					payload: { type: "usage", evidence: completeUsageEvidence },
				},
			}),
		);
	});

	it("refuses to dispatch an attempt again once it has finished", async () => {
		const intent = intentFor(crypto.randomUUID());
		await store.putIntent(intent);
		await store.claimDispatch(dispatchOf(intent));
		await store.putObservation({
			observationId: `${intent.attemptId}:terminal`,
			attemptId: intent.attemptId,
			observedAt: "2026-09-24T00:00:02.000Z",
			payload: { type: "terminal", endedAt: "2026-09-24T00:00:02.000Z", outcome: "succeeded" },
		});

		expect(await store.claimDispatch(dispatchOf(intent))).toBe("terminal");
	});

	it("cannot claim a dispatch for an attempt it has no intent for", async () => {
		expect(await store.claimDispatch(dispatchOf(intentFor(crypto.randomUUID())))).toBe("conflict");
	});

	it("keeps what a workspace spent after the workspace is deleted", async () => {
		const suffix = crypto.randomUUID();
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Ledger ${suffix}`, slug: `ledger-${suffix}` })
				.returning(),
		);
		if (!space) throw new Error("fixture");
		const intent = intentFor(space.id);
		await store.putIntent(intent);

		await onDatabase((db) => db.delete(workspace).where(eq(workspace.id, space.id)));

		const kept = await onDatabase((db) =>
			db.select().from(modelAttempt).where(eq(modelAttempt.attemptId, intent.attemptId)),
		);
		expect(kept).toHaveLength(1);
	});
});
