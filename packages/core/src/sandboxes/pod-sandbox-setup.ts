export * as PodSandboxSetup from "./pod-sandbox-setup.ts";

import type { PodSandbox } from "@sugabots/contracts";
import { sandboxProviderPreset } from "@sugabots/contracts";
import { Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { serviceOperations } from "../database/database.ts";
import { type UserFacing, UserMessage } from "../user-message.ts";
import { PodSandboxes } from "./pod-sandboxes.ts";
import { SandboxProviderRepository } from "./sandbox-provider-repository.ts";
import type { Sandboxes } from "./sandboxes.ts";

/**
 * A pod's sandbox for the people looking after the pod: how it stands for
 * anyone who can see the pod, and, for those who may update it, starting it
 * afresh or moving its work to a sandbox made from the current image.
 */
export interface Interface {
	readonly get: (
		podId: string,
	) => Effect.Effect<PodSandbox, AuthorizationDenied, CurrentActor.Service>;
	readonly reset: (
		podId: string,
	) => Effect.Effect<
		PodSandbox,
		AuthorizationDenied | PodSandboxes.SandboxInUse | Sandboxes.Unavailable,
		CurrentActor.Service
	>;
	readonly upgrade: (
		podId: string,
	) => Effect.Effect<
		PodSandbox,
		| AuthorizationDenied
		| NoSandboxProvider
		| PodSandboxes.SandboxInUse
		| PodSandboxes.NoSandbox
		| PodSandboxes.UpgradeFailed
		| Sandboxes.Unavailable,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/PodSandboxSetup",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("PodSandboxSetup");
	const authorization = yield* Authorization.Service;
	const podSandboxes = yield* PodSandboxes.Service;
	const providers = yield* SandboxProviderRepository.Service;

	const shown = (pod: PodSandboxes.Pod, canManage: boolean) =>
		Effect.gen(function* () {
			const current = yield* providers.enabled(pod.workspaceId);
			const status = yield* podSandboxes.status(pod, current);
			const providerEnabled = current !== undefined;
			if (status.kind === "none")
				return { sandbox: status, providerEnabled, canManage } satisfies PodSandbox;
			const row = (yield* providers.list(pod.workspaceId)).find(
				(candidate) => candidate.id === status.providerId,
			);
			return {
				sandbox: {
					kind: "present",
					state: status.state,
					image: status.image ?? null,
					providerName: row ? sandboxProviderPreset(row.preset).name : "Removed provider",
					createdAt: status.createdAt.toISOString(),
					lastUsedAt: status.lastUsedAt.toISOString(),
					turnsUsing: status.turnsUsing,
					peopleWatching: status.peopleWatching,
					upgradeAvailable: status.upgradeAvailable,
				},
				providerEnabled,
				canManage,
			} satisfies PodSandbox;
		});

	const standingIn = (podId: string, permission: "pod.read" | "sandbox.manage") =>
		Effect.map(authorization.pod(podId, permission), (standing) => ({
			pod: { workspaceId: standing.pod.workspaceId, podId: standing.pod.id },
			canManage: standing.may("sandbox.manage"),
		}));

	return Service.of({
		get: (podId) =>
			operation(
				"get",
				Effect.flatMap(standingIn(podId, "pod.read"), ({ pod, canManage }) =>
					shown(pod, canManage),
				),
			),

		reset: (podId) =>
			operation(
				"reset",
				Effect.gen(function* () {
					const { pod } = yield* standingIn(podId, "sandbox.manage");
					yield* podSandboxes.reset(pod);
					return yield* shown(pod, true);
				}),
			),

		upgrade: (podId) =>
			operation(
				"upgrade",
				Effect.gen(function* () {
					const { pod } = yield* standingIn(podId, "sandbox.manage");
					const provider = yield* providers.enabled(pod.workspaceId);
					if (!provider) return yield* new NoSandboxProvider();
					yield* podSandboxes.upgrade(pod, provider);
					return yield* shown(pod, true);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Authorization.layer, PodSandboxes.layer, SandboxProviderRepository.layer]),
);

/** No sandbox provider is enabled, so there's nothing to make a new sandbox with. */
export class NoSandboxProvider extends Data.TaggedError("NoSandboxProvider") implements UserFacing {
	get userMessage() {
		return UserMessage.of`Enable a sandbox provider in the workspace's settings first.`;
	}
}
