import { type Channel, EVENT_VERSION, type EventType, type StreamEvent } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { event } from "../schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../testing.ts";
import { type EventStore, memoryEventStore, postgresEventStore } from "./store.ts";

/**
 * Both stores, against the same cases.
 *
 * The memory one is what every other test in the tree turns on, so the pair has
 * to behave alike or those tests prove nothing about production. Postgres needs
 * a migrated database and skips without one, exactly as `db/schema.test.ts`
 * does; CI always has one.
 */

const DAY_MS = 24 * 60 * 60_000;

function rawEvent(type: EventType, data: Record<string, unknown> = {}): StreamEvent {
	return { ...data, v: EVENT_VERSION, type };
}

/** The memory store's clock, so its rows can be made to look old. */
let clock = new Date();

const stores = [
	{
		name: "memory",
		skip: false,
		make: () => memoryEventStore({ now: () => clock }),
		// Nothing here to reach into, so the store's clock moves on instead:
		// what is already written stays in the past, what comes next is today.
		backdate: async (_seq: number) => {
			clock = new Date();
		},
	},
	{
		name: "postgres",
		skip: !process.env.DATABASE_URL,
		make: () => runOnPostgres(postgresEventStore),
		backdate: async (seq: number) => {
			await onDatabase((db) =>
				db
					.update(event)
					.set({ createdAt: new Date(Date.now() - DAY_MS) })
					.where(eq(event.seq, seq)),
			);
		},
	},
];

afterAll(closeDatabase);

for (const { name, skip, make, backdate } of stores) {
	describe.skipIf(skip)(`${name} event store`, () => {
		let store: EventStore;
		// Channels are per-test so a shared Postgres instance, and whatever a
		// previous run left in it, cannot affect the result.
		let channel: Channel;

		beforeEach(async () => {
			clock = new Date(Date.now() - DAY_MS);
			store = await make();
			channel = `thread:${crypto.randomUUID()}`;
		});

		it("hands back a sequence number that rises", async () => {
			const first = await store.append(channel, rawEvent("message.created"));
			const second = await store.append(channel, rawEvent("message.completed"));

			expect(second).toBeGreaterThan(first);
		});

		it("replays a channel in order, after a point", async () => {
			const first = await store.append(channel, rawEvent("message.created", { n: 1 }));
			await store.append(channel, rawEvent("message.created", { n: 2 }));
			await store.append(channel, rawEvent("message.created", { n: 3 }));

			const replayed = await store.replay(channel, first, 10);

			expect(replayed.map((row) => row.event.n)).toEqual([2, 3]);
		});

		it("returns the envelope exactly as it was stored", async () => {
			const published = rawEvent("tool_call.completed", {
				threadId: "c1",
				output: { rows: [1, 2], nested: { ok: true } },
			});

			const seq = await store.append(channel, published);
			const [replayed] = await store.replay(channel, seq - 1, 10);

			expect(replayed?.event).toEqual(published);
		});

		it("honours the limit", async () => {
			for (const n of [1, 2, 3]) {
				await store.append(channel, rawEvent("message.created", { n }));
			}

			expect(await store.replay(channel, 0, 2)).toHaveLength(2);
		});

		it("never replays another channel's events", async () => {
			await store.append(`workspace:${crypto.randomUUID()}`, rawEvent("thread.created"));

			expect(await store.replay(channel, 0, 10)).toEqual([]);
		});

		it("knows whether a resume point is still here", async () => {
			const seq = await store.append(channel, rawEvent("message.created"));

			expect(await store.has(channel, seq)).toBe(true);
			expect(await store.has(channel, seq + 1_000_000)).toBe(false);
			// The row exists, but not on the channel the client is resuming.
			expect(await store.has(`thread:${crypto.randomUUID()}`, seq)).toBe(false);
		});

		it("prunes what is older than the cutoff and keeps the rest", async () => {
			const old = await store.append(channel, rawEvent("message.created"));
			await backdate(old);
			const kept = await store.append(channel, rawEvent("message.completed"));

			expect(await store.prune(new Date(Date.now() - 60_000))).toBeGreaterThanOrEqual(1);
			expect(await store.has(channel, old)).toBe(false);
			expect(await store.has(channel, kept)).toBe(true);
		});
	});
}
