import { AsyncLocalStorage } from "node:async_hooks";
import { Effect, type Tracer } from "effect";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { RunHandler } from "./handler.ts";

/**
 * A span per HTTP request, with every Effect a route runs as its child.
 *
 * Hono's middleware chain is promises, not Effects, so the request's span
 * cannot be the parent of a handler's `run(...)` the ordinary way. It is kept
 * in `AsyncLocalStorage` for the length of the request instead, and the `run`
 * returned here reads it from there.
 */
export interface RequestTracing {
	/** Opens the request's span. Must come before every other middleware, so their time is in it. */
	middleware: MiddlewareHandler;
	/** `run`, with the effect parented to the current request's span. */
	run: RunHandler;
}

const currentRequestSpan = new AsyncLocalStorage<Tracer.Span>();

export function requestTracing(run: RunHandler): RequestTracing {
	return {
		middleware: async (c, next) => {
			const started = performance.now();
			const route = routePath(c, -1);
			await run(
				Effect.useSpan(
					`${c.req.method} ${route}`,
					{
						kind: "server",
						attributes: {
							"http.request.method": c.req.method,
							"http.route": route,
							"url.path": c.req.path,
						},
					},
					(span) =>
						Effect.promise(async () => {
							await currentRequestSpan.run(span, next);
							span.attribute("http.response.status_code", c.res.status);
							// Visible in the browser's network panel with no trace backend at
							// all, and the trace id finds the full trace when there is one.
							const duration = (performance.now() - started).toFixed(1);
							c.header("Server-Timing", `app;dur=${duration}, trace;desc="${span.traceId}"`);
						}),
				),
			);
		},
		run: (effect) => {
			const span = currentRequestSpan.getStore();
			return run(span ? Effect.withParentSpan(effect, span) : effect);
		},
	};
}

/** The trace id of the request being handled, for tying a log line to its trace. */
export function currentTraceId(): string | undefined {
	return currentRequestSpan.getStore()?.traceId;
}
