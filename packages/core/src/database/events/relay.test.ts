import { PgClient } from "@effect/sql-pg";
import {
	type DurableEventType,
	type EventStream,
	type StreamEvent,
	streamEvent,
} from "@sugabots/contracts";
import { Effect, Layer, Queue } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ids } from "../../ids/ids.ts";
import { unimplemented } from "../../testing.ts";
import { closeDatabase, databaseForTests, runOnPostgres } from "../testing.ts";
import { EventBus } from "./bus.ts";
import { EventOutbox } from "./outbox.ts";
import { NoticesNotHeard, postgresEventRelay } from "./relay.ts";
import { EventStore } from "./store.ts";

/**
 * Two buses in one test process stand in for two API processes: each has its
 * own subscribers and relay identity, and they share only Postgres.
 */
describe.skipIf(!process.env.DATABASE_URL)("the event relay, between two buses", () => {
	let store: EventStore.Interface;
	const stream = `chat:relay-${Date.now()}` as const satisfies EventStream;
	const buses: EventBus.Interface[] = [];
	const subscriptions: AbortController[] = [];

	beforeAll(async () => {
		store = await runOnPostgres(EventStore.make);
	});

	/** A bus whose relay is listening: what is published after this is heard. */
	async function processBus(): Promise<EventBus.Interface> {
		const relay = await databaseForTests.runPromise(postgresEventRelay(store));
		let listening: Promise<unknown> = Promise.resolve();
		const bus = EventBus.inProcess({
			store,
			relay: {
				broadcast: relay.broadcast,
				listen: async (receive) => {
					const stop = relay.listen(receive);
					listening = stop;
					return stop;
				},
			},
		});
		buses.push(bus);
		await listening;
		return bus;
	}

	afterAll(async () => {
		for (const subscription of subscriptions) subscription.abort();
		await Promise.all(buses.map((bus) => bus.close()));
		await closeDatabase();
	});

	/** A subscriber to the stream, kept until the file ends, whose deliveries so far `reached` hands back once there are `count`. */
	function subscriberTo(bus: EventBus.Interface) {
		const stop = new AbortController();
		subscriptions.push(stop);
		const deliveries: EventBus.Delivery[] = [];
		const waiting: Array<{ count: number; resolve: (heard: EventBus.Delivery[]) => void }> = [];
		void (async () => {
			for await (const delivery of bus.subscribe(stream, { signal: stop.signal })) {
				deliveries.push(delivery);
				for (const { count, resolve } of waiting) {
					if (deliveries.length === count) resolve([...deliveries]);
				}
			}
		})();
		return {
			reached: (count: number) =>
				new Promise<EventBus.Delivery[]>((resolve) => {
					if (deliveries.length >= count) resolve(deliveries.slice(0, count));
					else waiting.push({ count, resolve });
				}),
		};
	}

	/** Stores `event` through the outbox, which hands it to `bus` once committed. */
	async function committedThrough(
		bus: EventBus.Interface,
		event: StreamEvent & { type: DurableEventType },
	): Promise<void> {
		const outbox = Effect.runSync(
			EventOutbox.make.pipe(Effect.provideService(EventBus.Service, bus)),
		);
		await runOnPostgres(outbox.publish([{ stream, event }]));
	}

	const changed = (chatId: string) => streamEvent("chat.changed", { chatId });

	it("delivers each committed event to the other process's subscribers once, and the writer's own only locally", async () => {
		const first = await processBus();
		const second = await processBus();
		const heardByFirst = subscriberTo(first);
		const heardBySecond = subscriberTo(second);

		// Each writes after it has heard the other's event, so every subscriber's
		// order is fixed, and a notice coming back to its own writer would show
		// up ahead of the other's event, which reaches that process after it.
		await committedThrough(first, changed("by-first"));
		await heardBySecond.reached(1);
		await committedThrough(second, changed("by-second"));
		await heardByFirst.reached(2);
		await committedThrough(first, changed("by-first-again"));

		const asHeard = (deliveries: EventBus.Delivery[]) =>
			deliveries.map(({ event }) => event.type === "chat.changed" && event.chatId);
		const expected = ["by-first", "by-second", "by-first-again"];
		const [atFirst, atSecond] = [await heardByFirst.reached(3), await heardBySecond.reached(3)];
		expect(asHeard(atFirst)).toEqual(expected);
		expect(asHeard(atSecond)).toEqual(expected);
		expect(atFirst.map(({ seq }) => seq)).toEqual(atSecond.map(({ seq }) => seq));
		expect(atFirst.map(({ seq }) => seq)).toEqual([
			expect.any(Number),
			expect.any(Number),
			expect.any(Number),
		]);
	});

	it("carries an ephemeral event, and fetches a durable one too large to carry", async () => {
		const writer = await processBus();
		const reader = await processBus();
		const heard = subscriberTo(reader);

		await writer.publish(
			stream,
			streamEvent("message.delta", {
				chatId: "t",
				messageId: "m",
				offset: 0,
				text: "hi",
				execution: 1,
			}),
		);
		const large = streamEvent("message.completed", {
			chatId: "t",
			messageId: "m",
			status: "complete",
			content: "x".repeat(9_000),
			finishedAt: "2026-11-23T10:00:00.000Z",
		});
		await committedThrough(writer, large);

		const deliveries = await heard.reached(2);
		expect(deliveries[0]).toEqual({ event: expect.objectContaining({ type: "message.delta" }) });
		expect(deliveries[1]).toMatchObject({ seq: expect.any(Number), event: large });
	});
});

/** A connection whose `LISTEN` succeeds and then hears nothing, as through PgBouncer. */
const deafListener = unimplemented(PgClient.PgClient, {
	listen: () => Queue.unbounded<never>(),
	notify: () => Effect.void,
});

describe("the event relay, listening on a connection that hears nothing", () => {
	it("fails with NoticesNotHeard instead of listening in silence", async () => {
		const outcome = Effect.gen(function* () {
			const relay = yield* postgresEventRelay({ replay: async () => [] });
			const listening = relay
				.listen(() => {})
				.then(
					() => "listening",
					(cause: unknown) => cause,
				);
			yield* TestClock.adjust("5 seconds");
			return yield* Effect.promise(() => listening);
		}).pipe(
			Effect.provide(Layer.mergeAll(deafListener, Ids.layer, TestClock.layer())),
			Effect.scoped,
		);

		expect(await Effect.runPromise(outcome)).toBeInstanceOf(NoticesNotHeard);
	});
});
