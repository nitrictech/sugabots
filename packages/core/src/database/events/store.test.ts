import {
	type DurableEventType,
	EVENT_VERSION,
	type EventStream,
	type StreamEvent,
} from "@sugabots/contracts";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { query, transaction } from "../database.ts";
import { event } from "../schema.ts";
import { closeDatabase, holdTransaction, onDatabase, runOnPostgres } from "../testing.ts";
import { EventBus } from "./bus.ts";
import { type CommittedEvent, EventOutbox } from "./outbox.ts";
import { EventStore } from "./store.ts";
import { inMemoryEventStore } from "./testing.ts";

/**
 * Both stores, against the same cases.
 *
 * The memory one is what every other test in the tree turns on, so the pair has
 * to behave alike or those tests prove nothing about production.
 */

const DAY_MS = 24 * 60 * 60_000;

type DurableEvent = StreamEvent & { type: DurableEventType };

function rawEvent(type: DurableEventType, data: Record<string, unknown> = {}): DurableEvent {
	return { ...data, v: EVENT_VERSION, type };
}

/** Stores events through the outbox, as production does, and says what each was numbered. */
async function storedThroughOutbox(stream: EventStream, stored: DurableEvent): Promise<number> {
	let committed: CommittedEvent[] = [];
	const bus = {
		...EventBus.inProcess(),
		publishCommitted: async (events: CommittedEvent[]) => {
			committed = events;
		},
	};
	const outbox = Effect.runSync(
		EventOutbox.make.pipe(Effect.provideService(EventBus.Service, bus)),
	);
	await runOnPostgres(outbox.publish([{ stream, event: stored }]));
	const [first] = committed;
	if (!first) throw new Error("The outbox committed nothing");
	return first.seq;
}

/** The memory store's clock, so its rows can be made to look old. */
let clock = new Date();

const stores = [
	{
		name: "memory",
		skip: false,
		make: async () => {
			const store = inMemoryEventStore({ now: () => clock });
			const append = async (stream: EventStream, stored: DurableEvent) =>
				store.record(stream, stored).seq;
			return { store, append };
		},
		// Nothing here to reach into, so the store's clock moves on instead:
		// what is already written stays in the past, what comes next is today.
		backdate: async (_seq: number) => {
			clock = new Date();
		},
	},
	{
		name: "postgres",
		skip: !process.env.DATABASE_URL,
		make: async () => ({
			store: await runOnPostgres(EventStore.make),
			append: storedThroughOutbox,
		}),
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
		let store: EventStore.Interface;
		let append: (stream: EventStream, stored: DurableEvent) => Promise<number>;
		// Streams are per-test so a shared Postgres instance, and whatever a
		// previous run left in it, cannot affect the result.
		let stream: EventStream;

		beforeEach(async () => {
			clock = new Date(Date.now() - DAY_MS);
			({ store, append } = await make());
			stream = `chat:${crypto.randomUUID()}`;
		});

		it("replays a stream in order, after a point", async () => {
			const first = await append(stream, rawEvent("message.created", { n: 1 }));
			await append(stream, rawEvent("message.created", { n: 2 }));
			await append(stream, rawEvent("message.created", { n: 3 }));

			const replayed = await store.replay(stream, first, 10);

			expect(replayed.map((row) => row.event.n)).toEqual([2, 3]);
		});

		it("returns the envelope exactly as it was stored", async () => {
			const published = rawEvent("tool_call.completed", {
				chatId: "c1",
				output: { rows: [1, 2], nested: { ok: true } },
			});

			const seq = await append(stream, published);
			const [replayed] = await store.replay(stream, seq - 1, 10);

			expect(replayed?.event).toEqual(published);
		});

		it("honours the limit", async () => {
			for (const n of [1, 2, 3]) {
				await append(stream, rawEvent("message.created", { n }));
			}

			expect(await store.replay(stream, 0, 2)).toHaveLength(2);
		});

		it("never replays another stream's events", async () => {
			await append(`workspace:${crypto.randomUUID()}`, rawEvent("chat.changed"));

			expect(await store.replay(stream, 0, 10)).toEqual([]);
		});

		it("knows whether a resume point is still here", async () => {
			const seq = await append(stream, rawEvent("message.created"));

			expect(await store.replayPage({ stream, cursor: seq }, 10)).toBeDefined();
			expect(await store.replayPage({ stream, cursor: seq + 1_000_000 }, 10)).toBeUndefined();
			// Another stream's row, after events of the stream the client is resuming.
			const elsewhere = await append(`chat:${crypto.randomUUID()}`, rawEvent("message.created"));
			expect(await store.replayPage({ stream, cursor: elsewhere }, 10)).toBeUndefined();
		});

		it("refuses an empty stream's cursor on another empty stream", async () => {
			const other: EventStream = `chat:${crypto.randomUUID()}`;
			const cursor = (await store.latest([stream, other])).get(stream);
			if (cursor === undefined) throw new Error("The stream has no cursor");

			expect(await store.replayPage({ stream: other, cursor }, 10)).toBeUndefined();
			expect(await store.replayPage({ stream, cursor }, 10)).toEqual([]);
		});

		it("starts a stream with nothing stored where every stream is, and resumes it from there", async () => {
			const elsewhere = await append(`chat:${crypto.randomUUID()}`, rawEvent("message.created"));

			const cursor = (await store.latest([stream])).get(stream);
			if (cursor === undefined) throw new Error("The stream has no cursor");
			expect(EventStore.afterCursor(cursor)).toBe(elsewhere);

			const first = await append(stream, rawEvent("message.created"));

			expect((await store.replayPage({ stream, cursor }, 10))?.map(({ seq }) => seq)).toEqual([
				first,
			]);
		});

		it("replays at most 5,000 missed events through the startup cursor", async () => {
			const changed = rawEvent("chat.changed");
			const cursor = await append(stream, changed);
			await append(`chat:${crypto.randomUUID()}`, changed);
			const first = await append(stream, changed);
			const middleEvents = 5_000 - 2;
			if (name === "postgres") {
				await onDatabase((db) =>
					db.execute(
						sql`insert into event (stream, type, payload)
							select ${stream}, ${changed.type}, ${JSON.stringify(changed)}::jsonb
							from generate_series(1, ${middleEvents}::int)`,
						"objects",
					),
				);
			} else {
				for (let index = 0; index < middleEvents; index++) await append(stream, changed);
			}
			const through = await append(stream, changed);
			const overflow = await append(stream, changed);

			expect(await store.replayPage({ stream, cursor, through }, 1)).toEqual([
				{ stream, seq: first, event: changed },
			]);
			expect(await store.replayPage({ stream, cursor, through: overflow }, 1)).toBeUndefined();
		});

		it.skipIf(name !== "postgres")(
			"takes starting positions while another reader holds the stream lock",
			async () => {
				const reader = holdTransaction(
					query((db) =>
						db.execute(
							sql`select pg_advisory_xact_lock_shared(hashtextextended(${stream}, 0))`,
							"objects",
						),
					),
				);
				await reader.held;
				const stopWatching = new AbortController();
				try {
					const starts = await Promise.race([
						store.latest([stream, stream]),
						reader.waitForWaiters(1, stopWatching.signal).then(() => null),
					]);
					expect(starts?.size).toBe(1);
					expect(starts?.has(stream)).toBe(true);
				} finally {
					stopWatching.abort();
					await reader.release();
				}
			},
		);

		it("merges live feeds in sequence order without repeating overlapping events", async () => {
			const control: EventStream = `workspace:${crypto.randomUUID()}`;
			const cursor = await append(stream, rawEvent("message.created"));
			await append(control, rawEvent("chat.changed"));
			const first = await append(control, rawEvent("reach.changed"));
			const second = await append(stream, rawEvent("message.created"));
			await append(control, rawEvent("reach.changed"));
			const feed = { stream: control, since: cursor, types: ["reach.changed"] as const };

			const page = await store.following([{ stream, since: cursor }, feed, feed], 2);
			expect(page.map(({ seq }) => seq)).toEqual([first, second]);
		});

		it.skipIf(name !== "postgres").each(["replay", "following"] as const)(
			"does not scan unrelated events when reading sparse feeds through %s",
			async (read) => {
				const control: EventStream = `workspace:${crypto.randomUUID()}`;
				const noise: EventStream = `workspace:${crypto.randomUUID()}`;
				const cursor = await append(stream, rawEvent("message.created"));
				await onDatabase((db) =>
					db.execute(
						sql`
					insert into event (stream, type, payload)
					select case when n % 2 = 0 then ${control} else ${noise} end,
						case when n % 2 = 0 then 'message.created' else 'reach.changed' end, '{}'::jsonb
					from generate_series(1, 20000) n
				`,
						"objects",
					),
				);
				const after = await append(stream, rawEvent("message.created"));
				const changed = await append(control, rawEvent("reach.changed"));
				await onDatabase((db) => db.execute(sql`analyze event`, "objects"));

				const countFetched = query((db) =>
					db.execute<{ fetched: string }>(
						sql`select seq_tup_read + idx_tup_fetch as fetched
							from pg_stat_xact_user_tables where relname = 'event'`,
						"objects",
					),
				).pipe(Effect.map(([stats]) => Number(stats?.fetched)));
				const { page, fetched } = await runOnPostgres(
					transaction(
						Effect.gen(function* () {
							const inTransaction = yield* EventStore.make;
							const fetchedBefore = yield* countFetched;
							const controls = [
								{ stream: control, since: cursor, types: ["reach.changed", "session.ended"] },
							] as const;
							const page = yield* Effect.promise((signal) =>
								read === "replay"
									? inTransaction.replayPage({ stream, cursor }, 100, signal)
									: inTransaction.following([{ stream, since: cursor }, ...controls], 100, signal),
							);
							const fetched = (yield* countFetched) - fetchedBefore;
							return { page, fetched };
						}),
					),
				);
				expect(page?.map(({ seq }) => seq)).toEqual(read === "replay" ? [after] : [after, changed]);
				expect(fetched).toBeGreaterThan(0);
				expect(fetched).toBeLessThan(100);
			},
		);

		it("prunes what is older than the cutoff and keeps the rest", async () => {
			const old = await append(stream, rawEvent("message.created"));
			await backdate(old);
			const kept = await append(stream, rawEvent("message.completed"));

			expect(await store.prune(new Date(Date.now() - 60_000))).toBeGreaterThanOrEqual(1);
			expect(await store.replayPage({ stream, cursor: old }, 10)).toBeUndefined();
			expect(await store.replayPage({ stream, cursor: kept }, 10)).toBeDefined();
		});
	});
}
