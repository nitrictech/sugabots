export * as DesktopViewer from "./viewer.ts";

import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer, type Scope } from "effect";
import type { AuthorizationDenied } from "../../../authorization/access.ts";
import { Authorization } from "../../../authorization/authorization.ts";
import type { CurrentActor } from "../../../authorization/current-actor.ts";
import { Visibility } from "../../../authorization/visibility.ts";
import { query, serviceOperations } from "../../../database/database.ts";
import { threadParticipant } from "../../../database/schema.ts";
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
 * agent may open it, while the agent takes part in the thread and uses the
 * pod's sandbox. Those holding `sandbox.desktop.use` may click and type on
 * it too; anyone else only watches. Opening it uses the pod's sandbox as a
 * turn would, resuming it, or making it if the pod has none, and starts the
 * desktop if it isn't running; the sandbox stays awake while it is open.
 */
export interface Interface {
	/**
	 * Where the desktop's VNC server takes a WebSocket, and its password, for
	 * as long as the scope is open, which holds the sandbox awake.
	 */
	readonly open: (input: {
		threadId: string;
		agentId: string;
	}) => Effect.Effect<
		OpenDesktop,
		AuthorizationDenied | DesktopUnavailable | Sandboxes.Unavailable,
		CurrentActor.Service | Scope.Scope
	>;
}

/**
 * The VNC server a person reaches the desktop through, and its password, for
 * Sugabots to answer with on their behalf: they never see it.
 */
export interface OpenDesktop {
	readonly endpoint: Sandboxes.Endpoint;
	readonly password: string;
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
	const operation = yield* serviceOperations<Interface>("DesktopViewer");

	/** Whether the agent is the thread's host or was added to it. */
	const takesPart = (thread: { id: string; hostAgentId: string }, agentId: string) =>
		thread.hostAgentId === agentId
			? Effect.succeed(true)
			: operation(
					"open",
					query((db) =>
						db
							.select({ id: threadParticipant.id })
							.from(threadParticipant)
							.where(
								and(
									eq(threadParticipant.threadId, thread.id),
									eq(threadParticipant.agentId, agentId),
								),
							)
							.limit(1),
					),
				).pipe(Effect.map((rows) => rows.length > 0));

	return Service.of({
		open: ({ threadId, agentId }) =>
			Effect.gen(function* () {
				const { thread } = yield* visibility.thread(threadId);
				const { agent, may } = yield* authorization.agent(agentId, "pod.read");
				if (agent.podId !== thread.podId || !(yield* takesPart(thread, agentId))) {
					return yield* new DesktopUnavailable({ reason: NOT_IN_THIS_THREAD });
				}
				// The UI hides the desktop then too, but this is what stops a request
				// from making a sandbox for an agent that a sandbox manager kept off.
				if (!agent.usesSandbox) return yield* new DesktopUnavailable({ reason: NO_SANDBOX });
				const pod = { workspaceId: thread.workspaceId, podId: thread.podId };
				const provider = yield* providers.enabled(pod.workspaceId);
				if (!provider) return yield* new DesktopUnavailable({ reason: SANDBOXES_OFF });
				const holder: PodSandboxes.Holder = { kind: "viewer", id: yield* ids.random };
				yield* Effect.addFinalizer(() => podSandboxes.release(holder));
				const { sandbox } = yield* podSandboxes.open(pod, provider, holder);
				const turn = { threadId, agentId };
				const desktop = yield* startDesktop(sandbox, placeOf(turn), turn);
				// The watch server ignores input, so a viewer's mouse and keys never
				// reach the desktop, whatever their client sends.
				const server = may("sandbox.desktop.use") ? desktop.control : desktop.watch;
				yield* Effect.forkScoped(
					podSandboxes.renew(holder).pipe(Effect.delay(PodSandboxes.LEASE_RENEWAL), Effect.forever),
				);
				return { endpoint: yield* sandbox.endpoint(server.port), password: server.password };
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
const NO_SANDBOX = UserMessage.of`This agent doesn't use the pod's sandbox, so it has no desktop.`;
const SANDBOXES_OFF = UserMessage.of`Sandboxes are switched off for this workspace, so there's no desktop to open.`;
