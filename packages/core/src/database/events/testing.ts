import type { DurableEventType, EventStream, StreamEvent } from "@sugabots/contracts";
import type { CommittedEvent } from "./outbox.ts";
import type { EventStore } from "./store.ts";

interface MemoryRow extends EventStore.Stored {
	stream: EventStream;
	createdAt: Date;
}

interface InMemoryOptions {
	/** The clock rows are stamped with. Only pruning reads it, and only a test
	 * ever needs to move it. */
	now?: () => Date;
}

/** The memory store, and `record`, which stands in for the outbox's insert. */
export interface InMemoryEventStore extends EventStore.Interface {
	/** Stores `event` as the outbox would, ready to hand to `EventBus.publishCommitted`. */
	record(stream: EventStream, event: StreamEvent & { type: DurableEventType }): CommittedEvent;
}

/**
 * The same store, in an array. Sequence numbers are global and monotonic here
 * too, so anything that depends on ordering behaves as it does in Postgres.
 */
export function inMemoryEventStore({
	now = () => new Date(),
}: InMemoryOptions = {}): InMemoryEventStore {
	const rows: MemoryRow[] = [];
	let next = 0;

	return {
		record(stream, event) {
			next += 1;
			rows.push({ seq: next, stream, event, createdAt: now() });
			return { stream, seq: next, event };
		},

		async replay(stream, since, limit) {
			return rows
				.filter((row) => row.stream === stream && row.seq > since)
				.slice(0, limit)
				.map(({ seq, event }) => ({ seq, event }));
		},

		async following(feeds, limit) {
			return rows
				.filter((row) =>
					feeds.some(
						(feed) =>
							feed.stream === row.stream &&
							row.seq > feed.since &&
							(feed.types === undefined || feed.types.some((type) => type === row.event.type)),
					),
				)
				.slice(0, limit)
				.map(({ seq, stream, event }) => ({ seq, stream, event }));
		},

		async latest(stream) {
			return rows.filter((row) => row.stream === stream).at(-1)?.seq ?? 0;
		},

		async has(stream, seq) {
			return rows.some((row) => row.stream === stream && row.seq === seq);
		},

		async prune(before) {
			const survivors = rows.filter((row) => row.createdAt >= before);
			const removed = rows.length - survivors.length;
			rows.splice(0, rows.length, ...survivors);
			return removed;
		},
	};
}
