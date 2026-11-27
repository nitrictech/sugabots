import { Context, Effect, Layer } from "effect";
import { Tier } from "../../../packages/contracts/src/tiers.ts";
import { processLayer } from "../../../packages/core/src/tiers.ts";

export class Registry extends Context.Service<Registry, { readonly size: number }>()(
	"fixtures/Registry",
) {
	declare readonly [Tier]: "process";
}

const make = Effect.succeed(Registry.of({ size: 0 }));

export const unwrapped = Layer.effect(Registry)(make);
export const halfway = make.pipe(Layer.effect(Registry));
export const wrapped = processLayer(Layer.effect(Registry)(make));
