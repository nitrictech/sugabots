export * as SandboxCredentials from "./sandbox-credentials.ts";

import { Context, type DateTime, Effect, Layer } from "effect";
import type { Sandboxes } from "./sandboxes.ts";

/**
 * What a bot's computer is signed in to the services it uses with, such
 * as its repositories. The provider adds these outside the sandbox, so the
 * sandbox only ever holds placeholders. Sandboxes don't know where they come
 * from: entry points provide the implementation (see
 * `git-hosts/repository-sign-in.ts`).
 */
export interface Interface {
	/** The bot's sign-ins now. One that can't be had is left out, and logged. */
	readonly forAgent: (agent: { workspaceId: string; agentId: string }) => Effect.Effect<SignedIn>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/SandboxCredentials",
) {}

/** Sign-ins for a bot's computer, and when they must be replaced. */
export interface SignedIn {
	readonly credentials: readonly Sandboxes.Credential[];
	/** Placeholders that tell command-line tools they are signed in. */
	readonly environment: Readonly<Record<string, string>>;
	/** When the first of them stops working; undefined when none expire. */
	readonly expiresAt: DateTime.Utc | undefined;
}

export const NOT_SIGNED_IN: SignedIn = { credentials: [], environment: {}, expiresAt: undefined };

/** For a bot whose computer is signed in to nothing. */
export const none = Layer.succeed(Service, {
	forAgent: () => Effect.succeed(NOT_SIGNED_IN),
});
