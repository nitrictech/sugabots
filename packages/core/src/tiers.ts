/**
 * Tiers: how long something lives once built, and the check that a longer-lived
 * thing does not depend on a shorter-lived one.
 *
 * - **process**: built once, at boot, and shared by every workspace.
 * - **workspace**: built once per workspace. Kept empty on purpose: services
 *   take the workspace as an argument instead, so none can be built for the
 *   first workspace that asks and then lent to every other.
 * - **request**: built for one HTTP request or one tool call in the bot loop.
 *
 * A service declares its tier with a type-only field, and its layer goes
 * through the wrapper for that tier:
 *
 * ```ts
 * export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Chats") {
 * 	declare readonly [Tier]: "process";
 * }
 * export const layerNoDeps = processLayer(Layer.effect(Service, make));
 * ```
 *
 * `lint/check-service-tiers.ts` fails lint for a service without a tier and
 * for a layer building one that does not go through its wrapper. Where
 * wrapping would re-indent a long layer, `layer.pipe(processLayer)` does the
 * same.
 *
 * The check reads a layer's requirements, not its code: a cache filled on
 * first use or state at the top of a module is still for review to catch.
 */

import { Tier, type TierName } from "@sugabots/contracts/tiers";
import type { Layer } from "effect";

/** `Tier` and `TierName` are declared in `contracts`, so that a service there can declare its tier too. */
export { Tier, type TierName };

/** What a thing built at each tier may depend on: its own tier or a longer-lived one. */
type MayDependOn<Built extends TierName> = Built extends "process"
	? "process"
	: Built extends "workspace"
		? "process" | "workspace"
		: TierName;

/**
 * The tier a service declared. Services from Effect and other libraries
 * declare none, and count as process tier.
 */
type TierOf<Service> = Service extends { readonly [Tier]: infer Declared extends TierName }
	? Declared
	: "process";

/** The requirements in `Requirements` that something built at `Built` may not depend on. */
type ShorterLived<Requirements, Built extends TierName> = Requirements extends unknown
	? TierOf<Requirements> extends MayDependOn<Built>
		? never
		: Requirements
	: never;

/**
 * Nothing when every requirement may be depended on; otherwise a property
 * named with the rule, which no layer has, so the call fails to compile and the
 * compiler prints the rule beside the services that broke it. TypeScript has no
 * custom errors.
 */
type NeedsOnlyProcessTier<Requirements> = [ShorterLived<Requirements, "process">] extends [never]
	? unknown
	: {
			readonly "built per workspace or per request, so a service built once at boot cannot depend on it": ShorterLived<
				Requirements,
				"process"
			>;
		};

/** Nothing when every service the layer provides is process tier; otherwise a property naming the rule. */
type ProvidesOnlyProcessTier<Provides> = [ShorterLived<Provides, "process">] extends [never]
	? unknown
	: {
			readonly "built per workspace or per request, so a layer built once at boot cannot provide it": ShorterLived<
				Provides,
				"process"
			>;
		};

/**
 * Marks `layer` as building process-tier services: it fails to compile when
 * the layer needs, or provides, a workspace-tier or request-tier service. Returns
 * `layer` unchanged.
 *
 * A layer that chooses what to build with `Layer.unwrap`, or builds a whole
 * context, is wrapped as a whole: what the outer effect needs counts too.
 */
export const processLayer = <Provides, Error, Requirements>(
	layer: Layer.Layer<Provides, Error, Requirements> &
		NeedsOnlyProcessTier<Requirements> &
		ProvidesOnlyProcessTier<Provides>,
): Layer.Layer<Provides, Error, Requirements> => layer;
