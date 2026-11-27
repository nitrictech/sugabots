export * as ComputerSignIn from "./computer-sign-in.ts";

import { Context, type DateTime, Effect, Layer } from "effect";
import { processLayer, Tier } from "../tiers.ts";
import type { Computers } from "./computers.ts";

/**
 * What a project's computer is signed in to the services it uses with, such
 * as its repositories. The provider adds these outside the computer, so the
 * computer only ever holds placeholders. Computers don't know where they come
 * from: entrypoints provide the implementation (see
 * `providers/connectors/github/github-sign-in.ts`).
 */
export interface Interface {
	/** Selects the current sign-in without asking its source for credentials. */
	readonly forProject: (project: {
		workspaceId: string;
		projectId: string;
	}) => Effect.Effect<Source | undefined>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ComputerSignIn",
) {
	declare readonly [Tier]: "process";
}

export interface Source {
	readonly revision: string;
	readonly load: Effect.Effect<SignedIn>;
}

/** Sign-ins for a project's computer, and when they must be replaced. */
export interface SignedIn {
	readonly credentials: readonly Computers.Credential[];
	/** When the first of them stops working; undefined when none expire. */
	readonly expiresAt: DateTime.Utc | undefined;
}

export const NOT_SIGNED_IN: Readonly<SignedIn> = { credentials: [], expiresAt: undefined };

/** For a project whose computer is signed in to nothing. */
export const none = processLayer(
	Layer.succeed(Service, {
		forProject: () => Effect.undefined,
	}),
);
