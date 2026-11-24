import { userText } from "@sugabots/errors";
import { type SQLWrapper, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { isUuid } from "../ids/ids.ts";
import type { UserFacing } from "../user-message.ts";

/**
 * Where a page read newest first ends, as the opaque token a client sends
 * back for the next page: the last row's timestamp and id.
 */
export interface CursorPoint {
	readonly at: Date;
	readonly id: string;
}

export function encodeCursor(point: CursorPoint): string {
	return Buffer.from(`${point.at.toISOString()}\n${point.id}`).toString("base64url");
}

/** The point `cursor` names, or `undefined` when it is not a token `encodeCursor` made. */
export function decodeCursor(cursor: string): CursorPoint | undefined {
	const decoded = Buffer.from(cursor, "base64url").toString();
	const [timestamp, id, extra] = decoded.split("\n");
	const at = timestamp ? new Date(timestamp) : new Date(Number.NaN);
	const wellFormed =
		extra === undefined &&
		timestamp &&
		id &&
		isUuid(id) &&
		!Number.isNaN(at.getTime()) &&
		at.toISOString() === timestamp &&
		Buffer.from(decoded).toString("base64url") === cursor;
	return wellFormed ? { at, id } : undefined;
}

/** A page was asked for after a cursor that no page handed out. */
export class InvalidCursor extends Data.TaggedError("InvalidCursor") implements UserFacing {
	get userMessage() {
		return userText`That page cursor is invalid`;
	}
}

/** The point `cursor` names, or `InvalidCursor` when it is not a token `encodeCursor` made. */
export function parseCursor(cursor: string): Effect.Effect<CursorPoint, InvalidCursor> {
	const point = decodeCursor(cursor);
	return point ? Effect.succeed(point) : Effect.fail(new InvalidCursor());
}

/** Rows older than `point`, by timestamp and then id: the order every page is read in. */
export const earlierThan = (at: SQLWrapper, id: SQLWrapper, point: CursorPoint) =>
	sql<boolean>`(${at}, ${id}) < (${point.at}, ${point.id})`;
