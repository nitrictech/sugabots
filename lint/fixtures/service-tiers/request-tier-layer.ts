import { Context, Effect, Layer } from "effect";
import { Tier } from "../../../packages/contracts/src/tiers.ts";
import { processLayer } from "../../../packages/core/src/tiers.ts";

export class CurrentRequest extends Context.Service<CurrentRequest, { readonly id: string }>()(
	"fixtures/CurrentRequest",
) {
	declare readonly [Tier]: "request";
}

export const built = processLayer(Layer.effect(CurrentRequest, Effect.succeed({ id: "one" })));
