export * as ComputerCredentials from "./computer-credentials.ts";

import { Context, type DateTime, Effect, Layer } from "effect";
import type { Computers } from "./computers.ts";

/**
 * What a project's computer is signed in to the services it uses with, such
 * as its repositories. The provider adds these outside the computer, so the
 * computer only ever holds placeholders. Computers don't know where they come
 * from: entry points provide the implementation (see
 * `providers/connections/github/github-sign-in.ts`).
 */
export interface Interface {
	/** The project's sign-ins now. One that can't be had is left out, and logged. */
	readonly forProject: (project: {
		workspaceId: string;
		projectId: string;
	}) => Effect.Effect<SignedIn>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ComputerCredentials",
) {}

/** Sign-ins for a project's computer, and when they must be replaced. */
export interface SignedIn {
	readonly credentials: readonly Computers.Credential[];
	/** Placeholders that tell command-line tools they are signed in. */
	readonly environment: Readonly<Record<string, string>>;
	/** When the first of them stops working; undefined when none expire. */
	readonly expiresAt: DateTime.Utc | undefined;
}

export const NOT_SIGNED_IN: SignedIn = { credentials: [], environment: {}, expiresAt: undefined };

/** For a project whose computer is signed in to nothing. */
export const none = Layer.succeed(Service, {
	forProject: () => Effect.succeed(NOT_SIGNED_IN),
});
