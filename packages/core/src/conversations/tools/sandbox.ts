export * as SandboxTools from "./sandbox.ts";

import type { Tool, ToolSet } from "ai";
import { Cause, Context, Effect, Exit, Layer, type Scope } from "effect";
import { type RunEffect, serviceOperations } from "../../database/database.ts";
import { modelAcceptsImages } from "../../providers/model-providers/model-provider-reads.ts";
import { allowedHostsOf, blockedHostsOf } from "../../sandboxes/allowed-hosts.ts";
import { PodSandboxes } from "../../sandboxes/pod-sandboxes.ts";
import { SandboxNetwork } from "../../sandboxes/sandbox-network.ts";
import { SandboxProviderRepository } from "../../sandboxes/sandbox-provider-repository.ts";
import { SandboxSoftware } from "../../sandboxes/sandbox-software.ts";
import type { UserMessage } from "../../user-message.ts";
import { type BrowserSession, browserSession, browserTools } from "./browser/browser.ts";
import { REQUEST_NETWORK_ACCESS_TOOL, requestNetworkAccess } from "./network-access/tool.ts";
import {
	allowedHostsNote,
	type OpenSandbox,
	openOncePerTurn,
	type Place,
	placeOf,
	READ_FILE_TOOL,
	RUN_COMMAND_TOOL,
	readFileTool,
	runCommandTool,
	WRITE_FILE_TOOL,
	writeFileTool,
} from "./sandbox/tools.ts";
import { syncSoftware } from "./software/profile.ts";
import { REQUEST_SOFTWARE_TOOL, requestSoftware } from "./software/tool.ts";

/**
 * The tools that work in a pod's sandbox: `run_command`, `read_file` and
 * `write_file`, and the `browser_` tools of a browser the agent drives there
 * (see `browser/browser.ts`), and `request_network_access`, whose calls wait
 * for a person, to reach a host the sandbox may not. Offered to every turn,
 * and usable while the agent uses the sandbox and the workspace has an
 * enabled sandbox provider, looked up on every call, so enabling one applies
 * from the next turn. The sandbox is opened by a turn's first call to one of
 * the tools, not when the turn starts.
 */
export interface Interface {
	/**
	 * The tools for a turn in its agent's pod. While they are usable, the
	 * turn's lease on the sandbox is renewed while the scope is open and
	 * released when it closes, which is when the turn's run ends, or it stops
	 * to wait for an approval.
	 */
	readonly forTurn: (turn: Turn) => Effect.Effect<Offered, never, Scope.Scope>;
}

export interface Offered {
	/** The tools that run when called. */
	readonly tools: ToolSet;
	/** The tools whose calls wait for a person to allow them first: who is in `tools/approval-deciders.ts`. */
	readonly requests: Readonly<Record<string, Request>>;
	/** Calls to the tools and the requests are refused when this is false. */
	readonly usable: boolean;
	/** What the model is told of the sandbox with the turn, as it may change between turns. */
	readonly note: string | undefined;
}

/**
 * A tool whose calls wait for a person to allow them, unless `refusal` names
 * a reason nobody could: such a call is refused without asking anyone.
 */
export interface Request {
	readonly tool: Tool;
	readonly refusal: (input: unknown) => UserMessage | undefined;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/SandboxTools") {}

export const make = Effect.gen(function* () {
	const providers = yield* SandboxProviderRepository.Service;
	const podSandboxes = yield* PodSandboxes.Service;
	const network = yield* SandboxNetwork.Service;
	const software = yield* SandboxSoftware.Service;
	const operation = yield* serviceOperations<Interface>("SandboxTools");
	const offeredIn = ({
		turnId,
		place,
		acceptsImages,
		openSandbox,
		browser,
		run,
		blocked,
	}: Behind) => ({
		tools: {
			[RUN_COMMAND_TOOL]: runCommandTool(openSandbox, place),
			[READ_FILE_TOOL]: readFileTool(openSandbox, place, acceptsImages),
			[WRITE_FILE_TOOL]: writeFileTool(openSandbox, place),
			...browserTools(browser, acceptsImages),
		},
		requests: {
			[REQUEST_NETWORK_ACCESS_TOOL]: requestNetworkAccess({ turnId, network, blocked, run }),
			[REQUEST_SOFTWARE_TOOL]: requestSoftware({ turnId, software, openSandbox, run }),
		},
	});
	return Service.of({
		forTurn: ({ pod, turnId, threadId, agentId, model, usesSandbox }) =>
			Effect.gen(function* (): Effect.fn.Return<Offered, never, Scope.Scope> {
				const place = placeOf({ threadId, agentId });
				// Whether a model takes images shapes the tools, so it is asked even without a sandbox.
				const acceptsImages = yield* operation(
					"forTurn",
					modelAcceptsImages(pod.workspaceId, model),
				);
				const provider = usesSandbox ? yield* providers.enabled(pod.workspaceId) : undefined;
				if (!provider) {
					return {
						...offeredIn({
							turnId,
							place,
							acceptsImages,
							openSandbox: NEVER_OPENED,
							browser: browserSession(NEVER_OPENED, place, { threadId, agentId }),
							run: NEVER_RUN,
							blocked: [],
						}),
						usable: false,
						note: NO_SANDBOX_NOTE,
					};
				}
				const [allowedHosts, blocked] = yield* operation(
					"forTurn",
					Effect.all([allowedHostsOf(pod), blockedHostsOf(pod.workspaceId)]),
				);
				yield* Effect.addFinalizer(() => podSandboxes.release(turnId));
				yield* Effect.forkScoped(
					podSandboxes.renew(turnId).pipe(Effect.delay(PodSandboxes.LEASE_RENEWAL), Effect.forever),
				);
				// The tools run as promises; the opening logs through the turn's services.
				const runPromiseExit = Effect.runPromiseExitWith(yield* Effect.context<never>());
				const prepared = podSandboxes.open(pod, provider, turnId).pipe(
					// The folders are made on first use, so any sandbox gains them.
					Effect.tap(({ sandbox }) =>
						sandbox.exec(`mkdir -p '${place.folder}' '${place.home}'`, {
							timeout: "30 seconds",
							maxOutputCharacters: 2_000,
						}),
					),
					// As is the pod's software: a new sandbox installs it, and one that
					// has it builds nothing.
					Effect.tap(({ sandbox }) =>
						software.packagesOf(pod).pipe(
							Effect.flatMap((packages) => syncSoftware(sandbox, packages)),
							Effect.tap((synced) =>
								synced.exitCode === 0
									? Effect.void
									: Effect.logWarning(
											"Could not give a sandbox its pod's software",
											synced.stderr.text,
										),
							),
							Effect.catchTag("SandboxUnavailable", (failure) =>
								Effect.logWarning("Could not give a sandbox its pod's software", failure),
							),
						),
					),
				);
				const openSandbox = openOncePerTurn(() =>
					runPromiseExit(prepared).then((exit) => {
						if (Exit.isSuccess(exit)) return exit.value;
						throw Cause.squash(exit.cause);
					}),
				);
				const browser = browserSession(openSandbox, place, { threadId, agentId });
				yield* Effect.addFinalizer(() => Effect.promise(() => browser.close()));
				const run = <A, E>(effect: Effect.Effect<A, E>) =>
					runPromiseExit(effect).then((exit) => {
						if (Exit.isSuccess(exit)) return exit.value;
						throw Cause.squash(exit.cause);
					});
				return {
					...offeredIn({
						turnId,
						place,
						acceptsImages,
						openSandbox,
						browser,
						run,
						blocked: blocked.map((row) => row.host),
					}),
					usable: true,
					note: allowedHostsNote(allowedHosts),
				};
			}),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		PodSandboxes.layer,
		SandboxNetwork.layer,
		SandboxSoftware.layer,
		SandboxProviderRepository.layer,
	]),
);

/** What a turn's tools work through. */
interface Behind {
	readonly turnId: string;
	readonly place: Place;
	readonly acceptsImages: boolean;
	readonly openSandbox: OpenSandbox;
	readonly browser: BrowserSession;
	readonly run: RunEffect<never>;
	/** Hosts a request is refused for without asking anyone. */
	readonly blocked: readonly string[];
}

// Behind tools that aren't usable, whose calls are refused before they run.
const NEVER_OPENED: OpenSandbox = () =>
	Promise.reject(new Error("The sandbox tools aren't usable"));
const NEVER_RUN: RunEffect<never> = () =>
	Promise.reject(new Error("The sandbox tools aren't usable"));

const NO_SANDBOX_NOTE =
	"You have no sandbox in this turn, so calls to the sandbox tools are refused. If the task needs one, say so: a workspace admin can enable a sandbox provider and let you use it.";

/** A turn that may use its pod's sandbox. */
export interface Turn {
	readonly pod: PodSandboxes.Pod;
	/** Whether an admin let the turn's agent use the sandbox. */
	readonly usesSandbox: boolean;
	/** Holds the sandbox's lease while the turn runs. */
	readonly turnId: string;
	readonly threadId: string;
	readonly agentId: string;
	/** The agent's model, which decides whether results may carry images. */
	readonly model: string;
}

/** No sandbox tools, for cases that offer none. */
export const none: Interface = {
	forTurn: () => Effect.succeed({ tools: {}, requests: {}, usable: false, note: undefined }),
};
