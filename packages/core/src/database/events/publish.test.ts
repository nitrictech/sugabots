import { type Channel, EVENT_VERSION } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Data, Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { query, transaction } from "../database.ts";
import { event } from "../schema.ts";
import { closeDatabase, runOnPostgres } from "../testing.ts";
import { type CommittedEvent, eventPublisher, type PendingEvent } from "./publish.ts";

class Abandoned extends Data.TaggedError("Abandoned") {}

/**
 * The two promises `eventPublisher` makes: a row and its delivery stand or
 * fall with the transaction that published them, and a channel's deliveries
 * arrive in the order its transactions committed. Both need a real Postgres,
 * so the file skips without one, as `db/schema.test.ts` does.
 */

describe.skipIf(!process.env.DATABASE_URL)("eventPublisher", () => {
	const bus = { publishCommitted: vi.fn(async (_events: CommittedEvent[]) => {}) };
	const publish = eventPublisher(bus);
	let channel: Channel;

	afterAll(closeDatabase);

	beforeEach(() => {
		bus.publishCommitted.mockClear();
		// Per test, so a shared Postgres and whatever a previous run left in it
		// cannot affect the result.
		channel = `thread:${crypto.randomUUID()}`;
	});

	/** A durable event carrying a marker, so a delivery can be told from another. */
	const marked = (n: number): PendingEvent => ({
		channel,
		event: { v: EVENT_VERSION, type: "tool_call.completed", n },
	});

	/** What each `publishCommitted` call carried, in the order the calls came. */
	const deliveries = () => bus.publishCommitted.mock.calls.map(([events]) => events);

	const storedRows = () =>
		runOnPostgres(
			query((db) => db.select({ seq: event.seq }).from(event).where(eq(event.channel, channel))),
		);

	it("reaches the bus only once the transaction has committed", async () => {
		let deliveredBeforeCommit = -1;

		await runOnPostgres(
			transaction(
				Effect.gen(function* () {
					yield* publish([marked(1)]);
					deliveredBeforeCommit = bus.publishCommitted.mock.calls.length;
				}),
			),
		);

		expect(deliveredBeforeCommit).toBe(0);
		const [[committed] = []] = deliveries();
		expect(committed).toMatchObject({ channel, event: { type: "tool_call.completed", n: 1 } });
		expect(await storedRows()).toEqual([{ seq: committed?.seq }]);
	});

	it("numbers the events of one publish in the order given, each with its own row", async () => {
		await runOnPostgres(publish([marked(1), marked(2), marked(3)]));

		const [committed = []] = deliveries();
		expect(committed.map(({ event }) => event.n)).toEqual([1, 2, 3]);
		const seqs = committed.map(({ seq }) => seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect((await storedRows()).map(({ seq }) => seq).sort((a, b) => a - b)).toEqual(seqs);
		const stored = await runOnPostgres(
			query((db) =>
				db
					.select({ seq: event.seq, payload: event.payload })
					.from(event)
					.where(eq(event.channel, channel)),
			),
		);
		for (const { seq, event: published } of committed) {
			expect(stored.find((row) => row.seq === seq)?.payload).toMatchObject({ n: published.n });
		}
	});

	it("neither delivers nor keeps what a rolled-back transaction published", async () => {
		await expect(
			runOnPostgres(
				transaction(
					Effect.gen(function* () {
						yield* publish([marked(1)]);
						return yield* new Abandoned();
					}),
				),
			),
		).rejects.toBeInstanceOf(Abandoned);

		expect(bus.publishCommitted).not.toHaveBeenCalled();
		expect(await storedRows()).toEqual([]);
	});

	it("delivers a channel's events in commit order when transactions overlap", async () => {
		let releaseFirst = () => {};
		const holdFirst = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstInserted = () => {};
		const inserted = new Promise<void>((resolve) => {
			firstInserted = resolve;
		});

		const first = runOnPostgres(
			transaction(
				Effect.gen(function* () {
					yield* publish([marked(1)]);
					firstInserted();
					yield* Effect.promise(() => holdFirst);
				}),
			),
		);
		await inserted;

		// The second transaction wants the same channel, so it waits for the
		// first to commit rather than taking a later seq and committing earlier.
		let secondCommitted = false;
		const second = runOnPostgres(transaction(publish([marked(2)]))).then(() => {
			secondCommitted = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(secondCommitted).toBe(false);

		releaseFirst();
		await Promise.all([first, second]);

		const [firstEvent, secondEvent] = deliveries().map(([committed]) => committed);
		expect(firstEvent?.event.n).toBe(1);
		expect(secondEvent?.event.n).toBe(2);
		expect(firstEvent?.seq).toBeLessThan(secondEvent?.seq ?? 0);
	});
});
