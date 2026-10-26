export * as DesktopViewer from "./viewer.ts";

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
import { PodSandboxes } from "../../../sandboxes/pod-sandboxes.ts";
import { SandboxProviderRepository } from "../../../sandboxes/sandbox-provider-repository.ts";
import type { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import { placeOf } from "../sandbox/tools.ts";
import { DesktopUnavailable, startBrowser, type ViewerServers, windowViewers } from "./browser.ts";

/**
 * An agent's desktop in a thread, opened by a person to watch and use: the
 * web app draws it, and shows each of its windows, each app on a display of
 * its own, over VNC, with the browser's tabs, the terminal and the list of
 * windows from the desktop's server. Anyone who can read the thread and see
 * the agent may open it, while the agent takes part in the thread and uses
 * the pod's sandbox. Those holding `sandbox.desktop.use` may click and type
 * on it too; anyone else only watches. Opening it uses the pod's sandbox as a
 * turn would, resuming it, or making it if the pod has none, and starts the
 * browser if it isn't running; the sandbox stays awake while it is open.
 */
export interface Interface {
	/**
	 * Where the desktop's server takes WebSockets, and its password, for as
	 * long as the scope is open, which holds the sandbox awake.
	 */
	readonly openDesktopServer: (
		input: AgentInThread,
	) => Effect.Effect<OpenServer, OpenFailure, OpenRequirements>;
	/**
	 * Where the display of one of the desktop's windows takes a WebSocket over
	 * VNC, and its password, for as long as the scope is open: `browser`,
	 * `files`, or the number of a display the agent started.
	 */
	readonly openWindow: (
		input: AgentInThread & { window: string },
	) => Effect.Effect<OpenServer, OpenFailure, OpenRequirements>;
}

interface AgentInThread {
	threadId: string;
	agentId: string;
}

type OpenFailure = AuthorizationDenied | DesktopUnavailable | Sandboxes.Unavailable;
type OpenRequirements = CurrentActor.Service | Scope.Scope;

/**
 * A server a person reaches the desktop through, and its password, for
 * Sugabots to answer with on their behalf: they never see it.
 */
export interface OpenServer {
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
	const takesPart = (thread: { id: string; hostAgentId: string | null }, agentId: string) =>
		thread.hostAgentId === agentId
			? Effect.succeed(true)
			: operation(
					"openWindow",
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
	 * The pod's sandbox, held awake for as long as the scope is open, if the
	 * person may see the agent's desktop in the thread, and whether they may
	 * use it.
	 */
	const openSandbox = ({ threadId, agentId }: AgentInThread) =>
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
			yield* Effect.forkScoped(
				podSandboxes.renew(holder).pipe(Effect.delay(PodSandboxes.LEASE_RENEWAL), Effect.forever),
			);
			return { sandbox, mayUse: may("sandbox.desktop.use") };
		});

	/** The server of `servers` the person may reach, the watch one unless they may use the desktop. */
	const reach = (sandbox: Sandboxes.Sandbox, mayUse: boolean, servers: ViewerServers) => {
		// The watch password's viewers can't change anything, whatever their client sends.
		const server = mayUse ? servers.control : servers.watch;
		return Effect.map(sandbox.endpoint(server.port), (endpoint) => ({
			endpoint,
			password: server.password,
		}));
	};

	return Service.of({
		openDesktopServer: (turn) =>
			Effect.gen(function* () {
				const { sandbox, mayUse } = yield* openSandbox(turn);
				const { desktopServer } = yield* startBrowser(sandbox, placeOf(turn), turn);
				if (!desktopServer)
					return yield* new DesktopUnavailable({ reason: IMAGE_BEFORE_HTML_DESKTOP });
				return yield* reach(sandbox, mayUse, desktopServer);
			}),
		openWindow: ({ window, ...turn }) =>
			Effect.gen(function* () {
				const { sandbox, mayUse } = yield* openSandbox(turn);
				const servers = yield* windowViewers(sandbox, placeOf(turn), turn, window);
				return yield* reach(sandbox, mayUse, servers);
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

const NOT_IN_THIS_THREAD = userText`This agent has no desktop in this thread.`;
const NO_SANDBOX = userText`This agent doesn't use the pod's sandbox, so it has no desktop.`;
const IMAGE_BEFORE_HTML_DESKTOP = userText`This sandbox's image is from before desktops were drawn by the web app. Upgrade the pod's sandbox to open it.`;
const SANDBOXES_OFF = userText`Sandboxes are switched off for this workspace, so there's no desktop to open.`;
