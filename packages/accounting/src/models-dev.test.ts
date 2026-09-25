import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
	ModelsDevSnapshotError,
	type ModelsDevSnapshotInput,
	snapshotFromModelsDev,
} from "./models-dev.ts";

const snapshotFrom = (input: ModelsDevSnapshotInput) =>
	Result.getOrThrow(snapshotFromModelsDev(input));

describe("Models.dev snapshots", () => {
	it("captures source provenance, cache rates, and exact context tiers", () => {
		const snapshot = snapshotFrom({
			snapshotId: "snapshot-1",
			provider: "anthropic",
			model: "claude",
			connectionId: "connection-1",
			catalogGeneratedAt: "2026-09-18T00:00:00.000Z",
			retrievedAt: "2026-09-18T01:00:00.000Z",
			effectiveFrom: "2026-09-18T00:00:00.000Z",
			cost: {
				input: 3,
				output: 15,
				cache_read: 0.3,
				cache_write: 3.75,
				tiers: [
					{
						input: 6,
						output: 30,
						cache_read: 0.6,
						cache_write: 7.5,
						tier: { type: "context", size: 200_000 },
					},
				],
			},
		});

		expect(snapshot.source).toEqual({
			name: "models.dev",
			url: "https://models.dev",
			version: "2026-09-18T00:00:00.000Z",
			retrievedAt: "2026-09-18T01:00:00.000Z",
		});
		expect(snapshot.tiers.map((tier) => tier.minimumContextTokens)).toEqual([0, 200_000]);
		expect(snapshot.tiers[0]?.rates).toContainEqual({
			category: "cache-read-input",
			price: "0.3",
			unitTokens: 1_000_000,
		});
	});

	it("serializes scientific-notation rates as plain decimals", () => {
		const snapshot = snapshotFrom({
			snapshotId: "snapshot-small",
			provider: "local",
			model: "small",
			catalogGeneratedAt: "v1",
			retrievedAt: "2026-09-18T01:00:00.000Z",
			effectiveFrom: "2026-09-18T00:00:00.000Z",
			cost: { input: 1e-7, output: 2e-7 },
		});

		expect(snapshot.tiers[0]?.rates.map((rate) => rate.price)).toEqual(["0.0000001", "0.0000002"]);
	});

	it("rejects a rate that is not a non-negative number", () => {
		const result = snapshotFromModelsDev({
			snapshotId: "snapshot-invalid",
			provider: "local",
			model: "broken",
			catalogGeneratedAt: "v1",
			retrievedAt: "2026-09-18T01:00:00.000Z",
			effectiveFrom: "2026-09-18T00:00:00.000Z",
			cost: { input: -1, output: Number.NaN },
		});

		expect(Result.isFailure(result) && result.failure).toBeInstanceOf(ModelsDevSnapshotError);
	});
});
