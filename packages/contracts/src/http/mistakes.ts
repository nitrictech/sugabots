// biome-ignore-all lint/plugin/errors-implement-domain-error: A stand-in HTTP failure, as `errors.ts` declares them.
/**
 * Near-misses with the HTTP API, one per entry under `@ts-expect-error`.
 * Type-checked and never run or imported. The lint check reads each
 * directive's TS code and bracketed message fragment to verify that the line
 * fails for the intended reason.
 *
 * The operations here are stand-ins; the groups written by hand are real.
 */

import { PublicError, UserText } from "@sugabots/errors";
import { Schema } from "effect";
import { OperationContract, requireTrue } from "../operations/index.ts";
import type { ApiFailureClass } from "./errors.ts";
import type { SessionApi } from "./groups/session.ts";
import type { RoutesApart } from "./routes-apart.ts";

const heldBackFromBots = { kind: "heldBack", reason: "Stand-in." } as const;

/** A stand-in for reading who is signed in, offered where `SessionApi` already answers. */
const whoAmI = OperationContract.make("system.whoAmI", {
	description: "Who is signed in.",
	input: Schema.Struct({}),
	output: Schema.Void,
	errors: [],
	changes: false,
	http: { kind: "offered", method: "GET", path: "/Me" },
	botLoop: heldBackFromBots,
});

/** A stand-in offered at a route no endpoint written by hand answers. */
const whoElse = OperationContract.make("system.whoElse", {
	description: "Who else is signed in.",
	input: Schema.Struct({}),
	output: Schema.Void,
	errors: [],
	changes: false,
	http: { kind: "offered", method: "GET", path: "/me/others" },
	botLoop: heldBackFromBots,
});

requireTrue<RoutesApart<{ "system.whoElse": typeof whoElse }, typeof SessionApi>>();

// An operation offered at `GET /me`, which the session's own endpoint answers, matched as the router matches it.
// @ts-expect-error TS2344 [offered at a route an endpoint written by hand already answers]
requireTrue<RoutesApart<{ "system.whoAmI": typeof whoAmI }, typeof SessionApi>>();

/** `Conflict` declared without the status it is answered with, as deleting its status would leave it. */
class ConflictWithoutStatus extends Schema.TaggedError<ConflictWithoutStatus>()("Conflict", {
	message: UserText.schema,
	details: Schema.optional(Schema.Unknown),
	error: Schema.optional(PublicError),
}) {}

// An error mapped to a failure class that doesn't say its status, which the HTTP API would answer with 500.
// @ts-expect-error TS2322 [Property 'status' is missing in type 'typeof ConflictWithoutStatus']
export const statusless = { AlreadyInvited: ConflictWithoutStatus } satisfies Record<
	string,
	ApiFailureClass
>;
