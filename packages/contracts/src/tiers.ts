/**
 * The marker a service declares its tier with: how long it lives once built.
 * Services declare it as `declare readonly [Tier]: "process"`, and
 * `packages/core/src/tiers.ts` checks that a layer built once at boot does not
 * depend on, or provide, a shorter-lived service. It lives here so that
 * a service in this package, below `core`, can declare its tier too.
 */

/**
 * The key of the field a service declares its tier in. A real symbol, not a
 * `declare const`, because service modules import it as a value to name the
 * field, and an import of something that doesn't exist fails at load time.
 */
export const Tier: unique symbol = Symbol.for("@sugabots/contracts/Tier");

/**
 * - **process**: built once, at boot, and shared by every workspace.
 * - **workspace**: built once per workspace. Kept empty on purpose: services
 *   take the workspace as an argument instead.
 * - **request**: provided for one HTTP request or one tool call in the bot loop.
 */
export type TierName = "process" | "workspace" | "request";
