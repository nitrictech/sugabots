import { type Channel, streamEvent } from "@sugabots/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, databaseForTests, runOnPostgres } from "../testing.ts";
import { EventBus } from "./bus.ts";
import { postgresEventRelay } from "./relay.ts";
import { EventStore } from "./store.ts";

/**
 * Two buses in one test process stand in for two API processes: each has its
 * own subscribers and relay identity, and they share only Postgres.
 */
describe.skipIf(!process.env.DATABASE_URL)("the event relay, between two buses", () => {
	let store: EventStore.Interface;
	const channel = `thread:relay-${Date.now()}` as const satisfies Channel;
	const buses: EventBus.Interface[] = [];

	beforeAll(async () => {
		store = await runOnPostgres(EventStore.make);
	});

	async function processBus(): Promise<EventBus.Interface> {
		const bus = EventBus.inProcess({
			store,
			relay: await databaseForTests.runPromise(postgresEventRelay(store)),
		});
		buses.push(bus);
		return bus;
	}

	afterAll(async () => {
		await Promise.all(buses.map((bus) => bus.close()));
		await closeDatabase();
	});

	/** Collects deliveries on a channel until `count` have arrived. */
	function collect(bus: EventBus.Interface, count: number): Promise<EventBus.Delivery[]> {
		return new Promise((resolve, reject) => {
			const stop = new AbortController();
			const taken: EventBus.Delivery[] = [];
			const timer = setTimeout(() => {
				stop.abort();
				reject(new Error(`only ${taken.length} of ${count} arrived`));
			}, 3_000);
			void (async () => {
				for await (const delivery of bus.subscribe(channel, { signal: stop.signal })) {
					taken.push(delivery);
					if (taken.length === count) {
						clearTimeout(timer);
						stop.abort();
						resolve(taken);
					}
				}
			})();
		});
	}

	/** Listening is set up in the background; a publish before it is up would be missed. */
	async function listening(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 200));
	}

	it("delivers a committed event to the other process's subscribers, once", async () => {
		const writer = await processBus();
		const reader = await processBus();
		await listening();
		const heardByReader = collect(reader, 1);
		const heardByWriter = collect(writer, 1);
		const seq = await store.append(channel, streamEvent("thread.changed", { threadId: "t" }));

		await writer.publishCommitted([
			{ channel, seq, event: streamEvent("thread.changed", { threadId: "t" }) },
		]);

		expect(await heardByReader).toMatchObject([{ seq, event: { type: "thread.changed" } }]);
		expect(await heardByWriter).toHaveLength(1);
		// Nothing else arrives: the writer does not hear its own notice back.
		await new Promise((resolve) => setTimeout(resolve, 200));
	});

	it("carries an ephemeral event, and fetches a durable one too large to carry", async () => {
		const writer = await processBus();
		const reader = await processBus();
		await listening();
		const heard = collect(reader, 2);

		await writer.publish(
			channel,
			streamEvent("message.delta", { threadId: "t", messageId: "m", offset: 0, text: "hi" }),
		);
		const large = streamEvent("message.completed", {
			threadId: "t",
			messageId: "m",
			status: "complete",
			content: "x".repeat(9_000),
		});
		await writer.publish(channel, large);

		const deliveries = await heard;
		expect(deliveries[0]).toEqual({ event: expect.objectContaining({ type: "message.delta" }) });
		expect(deliveries[1]).toMatchObject({ seq: expect.any(Number), event: large });
	});
});
