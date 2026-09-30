import { randomUUID } from "node:crypto";
import { Usd } from "@sugabots/accounting";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { modelRequest } from "../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	type Promised,
	runOnPostgres,
} from "../database/testing.ts";
import { ModelRequests } from "./model-requests.ts";

/**
 * The ledger's writes against real SQL: that a request is on record before
 * it ends, and that its ending fills in the same row. The table's checks are
 * part of what this exercises. Needs a migrated database and skips without
 * one; CI always has one.
 */
describe.skipIf(!process.env.DATABASE_URL)("model requests, against Postgres", () => {
	let requests: Promised<ModelRequests.Interface>;
	beforeAll(async () => {
		requests = onPostgres(await runOnPostgres(ModelRequests.make));
	});
	afterAll(closeDatabase);

	const started = (): ModelRequests.Started => ({
		workspaceId: randomUUID(),
		activity: {
			purpose: "summary",
			podId: randomUUID(),
			threadId: randomUUID(),
			turnId: randomUUID(),
		},
		step: 0,
		providerId: randomUUID(),
		preset: "anthropic",
		model: "claude-haiku-4-5",
		startedAt: new Date("2026-09-28T10:00:00Z"),
	});

	const rowOf = async (id: string) => {
		const [row] = await onDatabase((db) =>
			db.select().from(modelRequest).where(eq(modelRequest.id, id)),
		);
		return row;
	};

	it("keeps a request that never ended as started, with what it was for", async () => {
		const request = started();
		const id = await requests.start(request);

		expect(await rowOf(id)).toMatchObject({
			workspaceId: request.workspaceId,
			purpose: "summary",
			podId: "podId" in request.activity ? request.activity.podId : undefined,
			agentId: null,
			outcome: "started",
			endedAt: null,
			costUsd: null,
		});
	});

	it("fills in the same row with how the request ended and what it cost", async () => {
		const id = await requests.start(started());
		await requests.finish(id, {
			outcome: "completed",
			usage: {
				inputTokens: 1_200,
				cacheReadTokens: 1_000,
				cacheWriteTokens: undefined,
				outputTokens: 80,
				reasoningTokens: undefined,
			},
			cost: { usd: Usd.make(0.0012345678), source: "models.dev@test" },
			endedAt: new Date("2026-09-28T10:00:03Z"),
		});

		expect(await rowOf(id)).toMatchObject({
			outcome: "completed",
			inputTokens: 1_200,
			cacheReadTokens: 1_000,
			cacheWriteTokens: null,
			outputTokens: 80,
			costUsd: 0.0012345678,
			costSource: "models.dev@test",
			endedAt: new Date("2026-09-28T10:00:03Z"),
		});
	});
});
