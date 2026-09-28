export * as ModelProbe from "./model-probe.ts";

import { Context, type Effect } from "effect";
import type { UserFacing } from "../../user-message.ts";

/**
 * Asking one of a workspace's models for a word, to learn whether it answers.
 * The conversations module implements it with the model client turns use, so
 * a test goes the way a turn would.
 */
export interface Interface {
	readonly probe: (workspaceId: string, modelId: string) => Effect.Effect<void, UserFacing>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ModelProbe") {}
