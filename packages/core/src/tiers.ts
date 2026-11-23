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
 * The check reads a layer's requirements, not its code: a cache filled on
 * first use or state at the top of a module is still for review to catch.
 */

import type { Layer } from "effect";

/**
 * The key of the field a service declares its tier in. A real symbol, not a
 * `declare const`, because service modules import it as a value to name the
 * field, and an import of something that doesn't exist fails at load time.
 */
export const Tier: unique symbol = Symbol.for("@sugabots/core/Tier");

export type TierName = "process" | "workspace" | "request";

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
type ProcessTierCheck<Requirements> = [ShorterLived<Requirements, "process">] extends [never]
	? unknown
	: {
			readonly "built per workspace or per request, so a service built once at boot cannot depend on it": ShorterLived<
				Requirements,
				"process"
			>;
		};

/**
 * Marks `layer` as building process-tier services: it fails to compile when
 * the layer needs a workspace-tier or request-tier service. Returns `layer`
 * unchanged.
 */
export const processLayer = <Provides, Error, Requirements>(
	layer: Layer.Layer<Provides, Error, Requirements> & ProcessTierCheck<Requirements>,
): Layer.Layer<Provides, Error, Requirements> => layer;
