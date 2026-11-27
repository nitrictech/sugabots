import { Context, Effect, Layer } from "effect";
import { Tier } from "../../../packages/contracts/src/tiers.ts";
import { processLayer } from "../../../packages/core/src/tiers.ts";

export class Registry extends Context.Service<Registry, { readonly size: number }>()(
	"fixtures/Registry",
) {
	declare readonly [Tier]: "process";
}

const make = Effect.succeed(Registry.of({ size: 0 }));

export const built = Layer.effect(Registry, make);
export const provided = Layer.succeed(Registry, { size: 1 });
export const context = Layer.succeedContext(Context.make(Registry, { size: 2 }));
export const discarded = Layer.effectDiscard(Effect.void);
export const chosen = Layer.unwrap(Effect.succeed(processLayer(built)));
export const buildable = Layer.fromBuild(() => Effect.succeed(Context.make(Registry, { size: 3 })));
