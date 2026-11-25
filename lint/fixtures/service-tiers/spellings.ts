import { Context as Ctx, Effect, Layer as Layers } from "effect";
import { processLayer } from "../../../packages/core/src/tiers.ts";

// A local symbol called Tier is not the marker.
const Tier = Symbol("not the marker");

export class NotMarked extends Ctx.Service<NotMarked, { readonly size: number }>()(
	"fixtures/NotMarked",
) {
	declare readonly [Tier]: "process";
}

export class Registry extends Ctx.Service<Registry, { readonly size: number }>()(
	"fixtures/Registry",
) {}

const key = Registry;
const make = Effect.succeed(Registry.of({ size: 0 }));

// An aliased import, and a service bound to another name, are still ours.
export const built = Layers.effect(key, make);
export const wrapped = processLayer(Layers.effect(key, make));
