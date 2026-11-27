import { Context, Effect, Layer, References } from "effect";
import { Tier } from "../../../packages/contracts/src/tiers.ts";
import { processLayer } from "../../../packages/core/src/tiers.ts";

/** Everything the check accepts: none of this is reported. */

export class Registry extends Context.Service<Registry, { readonly size: number }>()(
	"fixtures/Registry",
) {
	declare readonly [Tier]: "process";
}

export class CurrentRequest extends Context.Service<CurrentRequest, { readonly id: string }>()(
	"fixtures/CurrentRequest",
) {
	declare readonly [Tier]: "request";
}

const make = Effect.succeed(Registry.of({ size: 0 }));

export const wrapped = processLayer(Layer.effect(Registry, make));
export const piped = Layer.effect(Registry, make).pipe(processLayer);
export const curried = processLayer(Layer.effect(Registry)(make));
export const context = processLayer(Layer.succeedContext(Context.make(Registry, { size: 1 })));
export const discarded = processLayer(Layer.effectDiscard(Effect.void));
export const chosen = processLayer(Layer.unwrap(Effect.succeed(wrapped)));

// Effect's own services have no tier and count as process tier: nothing to wrap.
export const logLevel = Layer.succeed(References.CurrentLogLevel, "Debug");
