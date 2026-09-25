import { BadRequest, NotFound } from "@sugabots/contracts/http";
import type { EgressUrlValidator } from "@sugabots/core/providers/network/egress";
import { sandboxProviderOperations } from "@sugabots/core/providers/sandbox-providers/operations";
import type { SandboxProviderStore } from "@sugabots/core/providers/sandbox-providers/store";
import type { PodSandboxStore } from "@sugabots/core/sandboxes/store";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedPod, grantedWorkspace } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export interface SandboxProviderRoutesOptions {
	sandboxProviders: SandboxProviderStore;
	/** Pods' sandboxes, for whether one is up and in use. */
	podSandboxes: Pick<PodSandboxStore, "status" | "applyAllowedHosts" | "discard">;
	validateProviderUrl: EgressUrlValidator;
	/** Whether this installation lets a workspace choose `container` isolation. */
	allowsUnisolated: boolean;
}

export function sandboxProviderRoutes({
	sandboxProviders,
	podSandboxes,
	validateProviderUrl,
	allowsUnisolated,
}: SandboxProviderRoutesOptions) {
	const operations = sandboxProviderOperations({
		providers: sandboxProviders,
		validateProviderUrl,
		allowsUnisolated,
		podSandboxes,
	});

	return HttpApiBuilder.group(ServerApi, "sandboxProviders", (handlers) =>
		handlers
			.handle("get", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) => operations.get(workspaceId)),
			)
			.handle("replace", ({ payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId, actor }) =>
					operations
						.replace(workspaceId, actor.userId, payload)
						.pipe(asHttpError(sandboxProviderErrors)),
				),
			)
			.handle("update", ({ payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations.update(workspaceId, payload).pipe(asHttpError(sandboxProviderErrors)),
				),
			)
			.handle("remove", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations.remove(workspaceId).pipe(asHttpError(sandboxProviderErrors)),
				),
			)
			.handle("test", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations.test(workspaceId).pipe(asHttpError(sandboxProviderErrors)),
				),
			)
			.handle("podStatus", () =>
				Effect.flatMap(grantedPod, ({ pod }) => podSandboxes.status(pod.id)),
			)
			.handle("discardPod", () =>
				Effect.flatMap(grantedPod, ({ pod }) => Effect.asVoid(podSandboxes.discard(pod.id))),
			),
	);
}

const badRequest = (failure: { message: string }) => new BadRequest({ message: failure.message });

const sandboxProviderErrors = {
	SandboxProviderNotFound: (failure: { message: string }) =>
		new NotFound({ message: failure.message }),
	SandboxProviderUrlNotAllowed: badRequest,
	SandboxProviderApiKeyRequired: badRequest,
	SandboxIsolationNotAllowed: badRequest,
};
