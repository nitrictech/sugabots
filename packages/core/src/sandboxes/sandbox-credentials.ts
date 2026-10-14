export * as SandboxCredentials from "./sandbox-credentials.ts";

import { Context, type DateTime, Effect, Layer } from "effect";
import type { Sandboxes } from "./sandboxes.ts";

/**
 * What a pod's sandbox is signed in to the services its bots use with, such
 * as its repositories. The provider adds these outside the sandbox, so the
 * sandbox only ever holds placeholders. Sandboxes don't know where they come
 * from: entry points provide the implementation (see
 * `git-hosts/repository-sign-in.ts`).
 */
export interface Interface {
	/** The pod's sign-ins now. One that can't be had is left out, and logged. */
	readonly forPod: (pod: { workspaceId: string; podId: string }) => Effect.Effect<SignedIn>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/SandboxCredentials",
) {}

/** Sign-ins for a pod's sandbox, and when they must be replaced. */
export interface SignedIn {
	readonly credentials: readonly Sandboxes.Credential[];
	/** Placeholders that tell command-line tools they are signed in. */
	readonly environment: Readonly<Record<string, string>>;
	/** When the first of them stops working; undefined when none expire. */
	readonly expiresAt: DateTime.Utc | undefined;
}

export const NOT_SIGNED_IN: SignedIn = { credentials: [], environment: {}, expiresAt: undefined };

/** For a pod whose sandbox is signed in to nothing. */
export const none = Layer.succeed(Service, {
	forPod: () => Effect.succeed(NOT_SIGNED_IN),
});
