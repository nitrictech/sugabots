import type { DurableEventType, EventStream, StreamEvent } from "@sugabots/contracts";
import type { CommittedEvent } from "./outbox.ts";
import { EventStore } from "./store.ts";

interface MemoryRow extends EventStore.Stored {
	event: StreamEvent & { type: DurableEventType };
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
	const prunedThrough = new Map<EventStream, number>();

	const following = (feeds: ReadonlyArray<EventStore.Feed>, limit: number, through?: number) =>
		rows
			.filter(
				(row) =>
					(through === undefined || row.seq <= through) &&
					feeds.some(
						(feed) =>
							feed.stream === row.stream &&
							row.seq > feed.since &&
							(feed.types === undefined || feed.types.includes(row.event.type)),
					),
			)
			.slice(0, limit)
			.map(({ seq, stream, event }) => ({ seq, stream, event }));

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
			return following(feeds, limit);
		},

		async latest(streams) {
			return new Map(
				streams.map((stream) => [
					stream,
					rows.findLast(
						(row) => row.stream === stream && row.seq >= (prunedThrough.get(stream) ?? 0),
					)?.seq ?? EventStore.buildEmptyCursor(stream, next),
				]),
			);
		},

		async replayPage(page, limit) {
			if ("feed" in page) {
				return page.feed.since < (prunedThrough.get(page.feed.stream) ?? 0)
					? undefined
					: following([page.feed, ...page.controls], limit, page.through);
			}
			const { stream, cursor, controls } = page;
			const position = EventStore.afterCursor(cursor);
			const boundary = prunedThrough.get(stream) ?? 0;
			if (position < boundary) return undefined;
			const retained =
				typeof cursor === "string"
					? cursor === EventStore.buildEmptyCursor(stream, position) &&
						position <= next &&
						!rows.some((row) => row.stream === stream && row.seq >= boundary && row.seq <= position)
					: rows.some((row) => row.seq === cursor && row.stream === stream);
			return retained
				? following([{ stream, since: position }, ...controls], limit, page.through)
				: undefined;
		},

		async prune(before) {
			const survivors: MemoryRow[] = [];
			for (const row of rows) {
				if (row.createdAt >= before) survivors.push(row);
				else prunedThrough.set(row.stream, Math.max(prunedThrough.get(row.stream) ?? 0, row.seq));
			}
			const removed = rows.length - survivors.length;
			rows.splice(0, rows.length, ...survivors);
			return removed;
		},
	};
}
