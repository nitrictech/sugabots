export * as SandboxTools from "./sandbox.ts";

import type { UserText } from "@sugabots/errors";
import type { Tool, ToolSet } from "ai";
import { Cause, Context, Effect, Exit, Layer, type Scope } from "effect";
import { type RunEffect, serviceOperations } from "../../database/database.ts";
import { Ids } from "../../ids/ids.ts";
import { allowedHostsOf, blockedHostsOf } from "../../sandboxes/allowed-hosts.ts";
import { PodSandboxes } from "../../sandboxes/pod-sandboxes.ts";
import { SandboxNetwork } from "../../sandboxes/sandbox-network.ts";
import { SandboxProviderRepository } from "../../sandboxes/sandbox-provider-repository.ts";
import { Sandboxes } from "../../sandboxes/sandboxes.ts";
import { ThreadFiles } from "../thread-files/thread-files.ts";
import { type BrowserSession, browserSession, browserTools } from "./browser/browser.ts";
import { REQUEST_NETWORK_ACCESS_TOOL, requestNetworkAccess } from "./network-access/tool.ts";
import {
	type AttachToReply,
	allowedHostsNote,
	COPY_FILE_TO_SANDBOX_TOOL,
	copyFileToSandboxTool,
	type OpenSandbox,
	openOncePerTurn,
	type Place,
	placeOf,
	READ_FILE_TOOL,
	RUN_COMMAND_TOOL,
	readFileTool,
	runCommandTool,
	SHARE_FILE_TOOL,
	shareFileTool,
	WRITE_FILE_TOOL,
	writeFileTool,
} from "./sandbox/tools.ts";

/**
 * The tools that work in a pod's sandbox: `run_command`, `read_file`,
 * `write_file`, `copy_file_to_sandbox` and `share_file`, and the `browser_`
 * tools of a browser the agent drives there (see `browser/browser.ts`), and
 * `request_network_access`, whose calls wait for a person, to reach a host
 * the sandbox may not. Offered to every turn, and usable while the agent uses
 * the sandbox and the workspace has an enabled sandbox provider, looked up on
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
	/** The tools that run when called. */
	readonly tools: ToolSet;
	/** The tools whose calls wait for a person to allow them first: who is in `tools/approval-deciders.ts`. */
	readonly requests: Readonly<Record<string, Request>>;
	/** Calls to the tools and the requests are refused when this is false. */
	readonly usable: boolean;
	/** What the model is told of the sandbox with the turn, as it may change between turns. */
	readonly note: string | undefined;
	/** The sandbox and the agent's place in it, while the tools are usable, for other tools that work there. */
	readonly workspace: { readonly open: OpenSandbox; readonly place: Place } | undefined;
	/** Whether the sandbox's provider signs its requests in, outside it. */
	readonly signsIn: boolean;
}

/**
 * A tool whose calls wait for a person to allow them, unless `refusal` names
 * a reason nobody could: such a call is refused without asking anyone.
 */
export interface Request {
	readonly tool: Tool;
	readonly refusal: (input: unknown) => UserText | undefined;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/SandboxTools") {}

export const make = Effect.gen(function* () {
	const providers = yield* SandboxProviderRepository.Service;
	const podSandboxes = yield* PodSandboxes.Service;
	const sandboxes = yield* Sandboxes.Service;
	const network = yield* SandboxNetwork.Service;
	const files = yield* ThreadFiles.Service;
	const ids = yield* Ids.Service;
	const operation = yield* serviceOperations<Interface>("SandboxTools");
	const offeredIn = ({
		turnId,
		threadId,
		place,
		acceptsImages,
		openSandbox,
		browser,
		run,
		blocked,
		attach,
	}: Behind) => ({
		tools: {
			[RUN_COMMAND_TOOL]: runCommandTool(openSandbox, place),
			[READ_FILE_TOOL]: readFileTool(openSandbox, place, acceptsImages),
			[WRITE_FILE_TOOL]: writeFileTool(openSandbox, place),
			[COPY_FILE_TO_SANDBOX_TOOL]: copyFileToSandboxTool({
				openSandbox,
				place,
				threadId,
				files,
				ids,
				run,
			}),
			...(attach ? { [SHARE_FILE_TOOL]: shareFileTool(openSandbox, place, attach) } : {}),
			...browserTools(browser, acceptsImages),
		},
		requests: {
			[REQUEST_NETWORK_ACCESS_TOOL]: requestNetworkAccess({ turnId, network, blocked, run }),
		},
	});
	return Service.of({
		forTurn: ({ pod, turnId, threadId, agentId, acceptsImages, usesSandbox, attach }) =>
			Effect.gen(function* (): Effect.fn.Return<Offered, never, Scope.Scope> {
				const place = placeOf({ threadId, agentId });
				const provider = usesSandbox ? yield* providers.enabled(pod.workspaceId) : undefined;
				if (!provider) {
					return {
						...offeredIn({
							turnId,
							threadId,
							place,
							acceptsImages,
							attach,
							openSandbox: NEVER_OPENED,
							browser: browserSession(NEVER_OPENED, place, { threadId, agentId }),
							run: NEVER_RUN,
							blocked: [],
						}),
						usable: false,
						note: NO_SANDBOX_NOTE,
						workspace: undefined,
						signsIn: false,
					};
				}
				const [allowedHosts, blocked] = yield* operation(
					"forTurn",
					Effect.all([allowedHostsOf(pod), blockedHostsOf(pod.workspaceId)]),
				);
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
						threadId,
						place,
						acceptsImages,
						attach,
						openSandbox,
						browser,
						run,
						blocked: blocked.map((row) => row.host),
					}),
					usable: true,
					note: allowedHostsNote(allowedHosts),
					workspace: { open: openSandbox, place },
					signsIn: sandboxes.forConnection(provider.connection).capabilities.credentials !== "none",
				};
			}),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		PodSandboxes.layer,
		Sandboxes.layer,
		SandboxNetwork.layer,
		SandboxProviderRepository.layer,
		ThreadFiles.layer,
	]),
);

/** What a turn's tools work through. */
interface Behind {
	readonly turnId: string;
	readonly threadId: string;
	readonly place: Place;
	readonly acceptsImages: boolean;
	readonly openSandbox: OpenSandbox;
	readonly browser: BrowserSession;
	readonly run: RunEffect<never>;
	/** Hosts a request is refused for without asking anyone. */
	readonly blocked: readonly string[];
	readonly attach: AttachToReply | undefined;
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
	/** Whether the agent's model takes images, which results then may carry. */
	readonly acceptsImages: boolean;
	/**
	 * Attaches a file to the turn's reply, where people can be shown it: only
	 * in a chat's own thread, whose files the chat serves. Without it, the
	 * turn has no `share_file`.
	 */
	readonly attach?: AttachToReply;
}

/** No sandbox tools, for cases that offer none. */
export const none: Interface = {
	forTurn: () =>
		Effect.succeed({
			tools: {},
			requests: {},
			usable: false,
			note: undefined,
			workspace: undefined,
			signsIn: false,
		}),
};
