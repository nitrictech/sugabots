export * as SandboxTools from "./sandbox.ts";

import type { ToolSet } from "ai";
import { Cause, Context, Effect, Exit, Layer, type Scope } from "effect";
import { serviceOperations } from "../../database/database.ts";
import { allowedHostsOf } from "../../sandboxes/allowed-hosts.ts";
import { PodSandboxes } from "../../sandboxes/pod-sandboxes.ts";
import { SandboxProviderRepository } from "../../sandboxes/sandbox-provider-repository.ts";
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

/**
 * The tools that work in a pod's sandbox: `run_command`, `read_file` and
 * `write_file`. Offered to every turn, and usable while the agent uses the
 * sandbox and the workspace has an enabled sandbox provider, looked up on
 * every call, so enabling one applies from the next turn. The sandbox is
 * opened by a turn's first call to one of the tools, not when the turn starts.
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
	readonly tools: ToolSet;
	/** Calls to the tools are refused when this is false. */
	readonly usable: boolean;
	/** What the model is told of the sandbox with the turn, as it may change between turns. */
	readonly note: string | undefined;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/SandboxTools") {}

export const make = Effect.gen(function* () {
	const providers = yield* SandboxProviderRepository.Service;
	const podSandboxes = yield* PodSandboxes.Service;
	const operation = yield* serviceOperations<Interface>("SandboxTools");
	return Service.of({
		forTurn: ({ pod, turnId, threadId, agentId, usesSandbox }) =>
			Effect.gen(function* (): Effect.fn.Return<Offered, never, Scope.Scope> {
				const place = placeOf({ threadId, agentId });
				const provider = usesSandbox ? yield* providers.enabled(pod.workspaceId) : undefined;
				if (!provider)
					return { tools: toolsIn(NEVER_OPENED, place), usable: false, note: NO_SANDBOX_NOTE };
				const allowedHosts = yield* operation("forTurn", allowedHostsOf(pod));
				const holder: PodSandboxes.Holder = { kind: "turn", id: turnId };
				yield* Effect.addFinalizer(() => podSandboxes.release(holder));
				yield* Effect.forkScoped(
					podSandboxes.renew(holder).pipe(Effect.delay(PodSandboxes.LEASE_RENEWAL), Effect.forever),
				);
				// The tools run as promises; the opening logs through the turn's services.
				const runPromiseExit = Effect.runPromiseExitWith(yield* Effect.context<never>());
				const prepared = podSandboxes.open(pod, provider, holder).pipe(
					// The folders are made on first use, so any sandbox gains them.
					Effect.tap(({ sandbox }) =>
						sandbox.exec(`mkdir -p '${place.folder}' '${place.home}'`, {
							timeout: "30 seconds",
							maxOutputCharacters: 2_000,
						}),
					),
				);
				const openSandbox = openOncePerTurn(() =>
					runPromiseExit(prepared).then((exit) => {
						if (Exit.isSuccess(exit)) return exit.value;
						throw Cause.squash(exit.cause);
					}),
				);
				return {
					tools: toolsIn(openSandbox, place),
					usable: true,
					note: allowedHostsNote(allowedHosts),
				};
			}),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([PodSandboxes.layer, SandboxProviderRepository.layer]),
);

function toolsIn(openSandbox: OpenSandbox, place: Place): ToolSet {
	return {
		[RUN_COMMAND_TOOL]: runCommandTool(openSandbox, place),
		[READ_FILE_TOOL]: readFileTool(openSandbox, place),
		[WRITE_FILE_TOOL]: writeFileTool(openSandbox, place),
	};
}

/** Behind tools that aren't usable, whose calls are refused before they run. */
const NEVER_OPENED: OpenSandbox = () =>
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
}

/** No sandbox tools, for cases that offer none. */
export const none: Interface = {
	forTurn: () => Effect.succeed({ tools: {}, usable: false, note: undefined }),
};
