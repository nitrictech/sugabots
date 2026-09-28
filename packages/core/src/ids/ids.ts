export * as Ids from "./ids.ts";

import { randomBytes, randomUUID } from "node:crypto";
import { Clock, Context, Effect, Layer } from "effect";

/** Identifiers for new rows. */
export interface Interface {
	/**
	 * A new UUID v7, the same kind the database defaults to: time-ordered, so
	 * rows written together sit together in an index.
	 */
	readonly next: Effect.Effect<string>;
	/**
	 * A new UUID v4: all random bits, for an id that is also a link a person
	 * holds, such as an invitation's, where a time-ordered id would be partly
	 * guessable.
	 */
	readonly random: Effect.Effect<string>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Ids") {}

/** UUIDs from Node's secure random bytes, a v7 stamped with Effect's `Clock`. */
export const make = Effect.succeed(
	Service.of({
		next: Effect.map(Clock.currentTimeMillis, (millis) => uuidV7(millis, randomBytes(16))),
		random: Effect.sync(randomUUID),
	}),
);

export const layer = Layer.effect(Service, make);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** isUuid reports whether `value` is written as a UUID, of any version. */
export function isUuid(value: string): boolean {
	return UUID_PATTERN.test(value);
}

/** RFC 9562: a 48-bit millisecond timestamp, the version and variant bits, and random bits. */
function uuidV7(millis: number, bytes: Uint8Array): string {
	const timestamp = BigInt(Math.max(0, Math.trunc(millis)));
	for (let index = 0; index < 6; index++) {
		bytes[index] = Number((timestamp >> BigInt(8 * (5 - index))) & 0xffn);
	}
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Buffer.from(bytes).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
