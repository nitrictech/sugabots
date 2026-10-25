export * as DesktopViewer from "./viewer.ts";

import type { DesktopUnreachedSite } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer, type Scope } from "effect";
import type { AuthorizationDenied } from "../../../authorization/access.ts";
import { Authorization } from "../../../authorization/authorization.ts";
import type { CurrentActor } from "../../../authorization/current-actor.ts";
import { Visibility } from "../../../authorization/visibility.ts";
import { query, serviceOperations } from "../../../database/database.ts";
import { threadParticipant } from "../../../database/schema.ts";
import { Ids } from "../../../ids/ids.ts";
import {
	allowedHostsOf,
	blockedHostsOf,
	unallowedHosts,
} from "../../../sandboxes/allowed-hosts.ts";
import { PodSandboxes } from "../../../sandboxes/pod-sandboxes.ts";
import { SandboxProviderRepository } from "../../../sandboxes/sandbox-provider-repository.ts";
import type { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import { placeOf } from "../sandbox/tools.ts";
import {
	DesktopUnavailable,
	findUnreachedSites,
	reloadPagesThatFailedOn,
	startDesktop,
} from "./browser.ts";

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
	/**
	 * The sites the pages open in the agent's browser tried and failed to reach
	 * because the pod's sandbox doesn't allow them, for a person using its
	 * desktop to allow. None while its sandbox isn't running: a look never
	 * wakes it. Takes `sandbox.desktop.use`, as clicking and typing on it does.
	 */
	readonly unreachedSites: (input: {
		threadId: string;
		agentId: string;
	}) => Effect.Effect<
		readonly DesktopUnreachedSite[],
		AuthorizationDenied | DesktopUnavailable | Sandboxes.Unavailable,
		CurrentActor.Service
	>;
	/**
	 * Loads again the pages that failed to reach any of `hosts`, for a person
	 * who just allowed them, as reloading them by hand would. Takes
	 * `sandbox.desktop.use`.
	 */
	readonly reloadUnreachedSites: (input: {
		threadId: string;
		agentId: string;
		hosts: readonly string[];
	}) => Effect.Effect<
		void,
		AuthorizationDenied | DesktopUnavailable | Sandboxes.Unavailable,
		CurrentActor.Service
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

	/**
	 * The agent's desktop in the thread as the person may reach it: what they
	 * may do there, and the pod and provider of its sandbox.
	 */
	const findDesktop = (threadId: string, agentId: string) =>
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
			return { may, pod, provider };
		});

	/**
	 * The pod's sandbox, if it's running, for a person who may click and type
	 * on the agent's desktop, as one using it keeps it.
	 */
	const runningForControl = (threadId: string, agentId: string) =>
		Effect.gen(function* () {
			const { may, pod, provider } = yield* findDesktop(threadId, agentId);
			if (!may("sandbox.desktop.use")) return yield* new DesktopUnavailable({ reason: WATCH_ONLY });
			return { pod, sandbox: yield* podSandboxes.running(pod, provider) };
		});

	return Service.of({
		open: ({ threadId, agentId }) =>
			Effect.gen(function* () {
				const { may, pod, provider } = yield* findDesktop(threadId, agentId);
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

		unreachedSites: ({ threadId, agentId }) =>
			Effect.gen(function* () {
				const { pod, sandbox } = yield* runningForControl(threadId, agentId);
				if (!sandbox) return [];
				const turn = { threadId, agentId };
				const unreached = yield* findUnreachedSites(sandbox, placeOf(turn), turn);
				const [allowed, blocked] = yield* operation(
					"unreachedSites",
					Effect.all([allowedHostsOf(pod), blockedHostsOf(pod.workspaceId)]),
				);
				// A site the sandbox may reach failed for some other reason, such as
				// being down, which allowing it again wouldn't change.
				return unallowedHosts(
					unreached,
					allowed,
					blocked.map((row) => row.host),
				);
			}),

		reloadUnreachedSites: ({ threadId, agentId, hosts }) =>
			Effect.gen(function* () {
				const { sandbox } = yield* runningForControl(threadId, agentId);
				if (!sandbox) return;
				const turn = { threadId, agentId };
				yield* reloadPagesThatFailedOn(sandbox, placeOf(turn), turn, hosts);
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

const WATCH_ONLY = userText`You can only watch this desktop.`;
const NOT_IN_THIS_THREAD = userText`This agent has no desktop in this thread.`;
const NO_SANDBOX = userText`This agent doesn't use the pod's sandbox, so it has no desktop.`;
const SANDBOXES_OFF = userText`Sandboxes are switched off for this workspace, so there's no desktop to open.`;
