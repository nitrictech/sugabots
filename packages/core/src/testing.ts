import { type Context, Effect, Layer } from "effect";

/**
 * A layer for `service` whose methods are `implemented`. Calling any other
 * method dies with an error naming it, so a test that reaches past what it
 * set up fails at that call rather than on a made-up answer.
 */
export function unimplemented<Identifier, Shape extends object>(
	service: Context.Key<Identifier, Shape>,
	implemented: Partial<Shape> = {},
): Layer.Layer<Identifier> {
	const shape = new Proxy(implemented, {
		get: (target, method) =>
			typeof method !== "string" || method in target
				? target[method as keyof Shape]
				: () => Effect.die(new Error(`${service.key}.${method} has no test double in this test`)),
	}) as Shape;
	return Layer.succeed(service, shape);
}
