export * as DesktopViewer from "./viewer.ts";

import { Context, Effect, Layer, type Scope } from "effect";
import type { AuthorizationDenied } from "../../../authorization/access.ts";
import { Authorization } from "../../../authorization/authorization.ts";
import type { CurrentActor } from "../../../authorization/current-actor.ts";
import { Visibility } from "../../../authorization/visibility.ts";
import { Ids } from "../../../ids/ids.ts";
import { PodSandboxes } from "../../../sandboxes/pod-sandboxes.ts";
import { SandboxProviderRepository } from "../../../sandboxes/sandbox-provider-repository.ts";
import type { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import { UserMessage } from "../../../user-message.ts";
import { placeOf } from "../sandbox/tools.ts";
import { DesktopUnavailable, startDesktop } from "./browser.ts";

/**
 * An agent's desktop in a thread, opened by a person to watch and use: where
 * the browser it drives is shown. Anyone who can read the thread and see the
 * agent may open it. Opening it uses the pod's sandbox as a turn would,
 * resuming it, or making it if the pod has none, and starts the desktop if it
 * isn't running; the sandbox stays awake while it is open.
 */
export interface Interface {
	/**
	 * Where the desktop's VNC server takes a WebSocket, for as long as the
	 * scope is open, which holds the sandbox awake.
	 */
	readonly open: (input: {
		threadId: string;
		agentId: string;
	}) => Effect.Effect<
		Sandboxes.Endpoint,
		AuthorizationDenied | DesktopUnavailable | Sandboxes.Unavailable,
		CurrentActor.Service | Scope.Scope
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/DesktopViewer",
) {}

export const make = Effect.gen(function* () {
	const visibility = yield* Visibility.Service;
	const authorization = yield* Authorization.Service;
	const podSandboxes = yield* PodSandboxes.Service;
	const providers = yield* SandboxProviderRepository.Service;
	const ids = yield* Ids.Service;

	return Service.of({
		open: ({ threadId, agentId }) =>
			Effect.gen(function* () {
				const { thread } = yield* visibility.thread(threadId);
				const { agent } = yield* authorization.agent(agentId, "pod.read");
				if (!agent.podId || agent.workspaceId !== thread.workspaceId) {
					return yield* new DesktopUnavailable({ reason: NOT_IN_THIS_THREAD });
				}
				const pod = { workspaceId: agent.workspaceId, podId: agent.podId };
				const provider = yield* providers.enabled(pod.workspaceId);
				if (!provider) return yield* new DesktopUnavailable({ reason: SANDBOXES_OFF });
				const holder = `${PodSandboxes.VIEWER_HOLDER_PREFIX}${yield* ids.random}`;
				yield* Effect.addFinalizer(() => podSandboxes.release(holder));
				const { sandbox } = yield* podSandboxes.open(pod, provider, holder);
				const turn = { threadId, agentId };
				const desktop = yield* startDesktop(sandbox, placeOf(turn), turn);
				yield* Effect.forkScoped(
					podSandboxes.renew(holder).pipe(Effect.delay(PodSandboxes.LEASE_RENEWAL), Effect.forever),
				);
				return yield* sandbox.endpoint(desktop.viewerPort);
			}),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		Visibility.layer,
		Authorization.layer,
		PodSandboxes.layer,
		SandboxProviderRepository.layer,
	]),
);

const NOT_IN_THIS_THREAD = UserMessage.of`This agent has no desktop in this thread.`;
const SANDBOXES_OFF = UserMessage.of`Sandboxes are switched off for this workspace, so there's no desktop to open.`;
