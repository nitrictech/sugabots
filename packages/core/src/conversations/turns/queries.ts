/**
 * Conditions on turns, for other modules' queries to use inside their own
 * transactions.
 *
 * This file builds no services, so a module the turn's machinery depends on
 * can import it without loading that machinery: the collaboration repository
 * does, and `turns.ts` would bring it back round to itself.
 */
export * as TurnQueries from "./queries.ts";

import { inArray, type SQLWrapper } from "drizzle-orm";
import { turn } from "../../database/schema.ts";
import { laneBusy } from "../../workflows/lanes.ts";
import { ACTIVE_STATUSES } from "./lifecycle.ts";
import { Turn } from "./turn.workflow.ts";

/**
 * busyIn reports, as a condition for a query, whether an agent's turn in the
 * thread `threadId` is running or waiting to start.
 */
export const busyIn = (threadId: SQLWrapper) => laneBusy(threadId, [Turn._tag]);

/** isActive reports, as a condition for a query, whether a turn is running or waiting on approvals. */
export const isActive = inArray(turn.status, [...ACTIVE_STATUSES]);
