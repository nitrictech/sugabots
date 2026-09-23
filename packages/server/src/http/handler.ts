import type { Database } from "@sugabots/core/database/database";
import type { Effect } from "effect";
import type { HttpError } from "./errors.ts";

/**
 * How a route runs an Effect.
 *
 * The error channel is pinned to `HttpError`: a handler still carrying a
 * store's own error does not compile until `asHttpError` has given it a
 * status. The promise rejects with the `HttpError` itself, which is what lets
 * Hono's `onError` answer with its status; a defect rejects with the thrown
 * value, which `onError` logs and answers 500.
 *
 * The process's `RunEffect` satisfies this type, so `createApp` passes one
 * function to every route file.
 */
export type RunHandler = <A>(effect: Effect.Effect<A, HttpError, Database>) => Promise<A>;
