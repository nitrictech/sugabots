export * as ComputerTools from "./computer.ts";

import type { BotColor } from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import type { Tool, ToolSet } from "ai";
import { Context, Effect, Layer, type Scope } from "effect";
import { blockedHostsOf, reachOf } from "../../computers/allowed-hosts.ts";
import { ComputerNetwork } from "../../computers/computer-network.ts";
import { ComputerProviderRepository } from "../../computers/computer-provider-repository.ts";
import { Computers } from "../../computers/computers.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import { effectRunner, type RunEffect, serviceOperations } from "../../database/database.ts";
import { ConversationFiles } from "../../files/conversation-files.ts";
import { Ids } from "../../ids/ids.ts";
import { type BrowserSession, browserSession, browserTools } from "./browser/browser.ts";
import {
	type AttachToReply,
	COPY_FILE_TO_COMPUTER_TOOL,
	copyFileToComputerTool,
	diskNote,
	networkNote,
	type OpenComputer,
	openOncePerTurn,
	type Place,
	placeOf,
	READ_FILE_TOOL,
	RUN_COMMAND_TOOL,
	readFileTool,
	runCommandTool,
	SHARE_FILE_TOOL,
	shareFileTool,
	type TurnComputer,
	WRITE_FILE_TOOL,
	writeFileTool,
} from "./computer/tools.ts";
import { REQUEST_NETWORK_ACCESS_TOOL, requestNetworkAccess } from "./network-access/tool.ts";

/**
 * The tools that work in the computer of the project a turn works in:
 * `run_command`, `read_file`, `write_file`, `copy_file_to_computer` and
 * `share_file`, and the `browser_` tools of a browser the bot drives there
 * (see `browser/browser.ts`), and `request_network_access`, whose calls wait
 * for a person, to reach a host the computer may not. A bot working in
 * another project's thread uses that project's computer, not its own. Offered
 * to every turn, and usable while the bot uses computers, the turn works in a
 * project, and the workspace has an enabled computer provider, looked up on
 * every call, so enabling one applies from the next turn. The computer is
 * opened by a turn's first call to one of the tools, not when the turn starts.
 */
export interface Interface {
	/**
	 * The tools for a turn, in its project's computer. While they are usable, the
	 * turn's lease on the computer is renewed while the scope is open and
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
	/** What the model is told of the computer with the turn, as it may change between turns. */
	readonly note: string | undefined;
	/** The computer and the bot's place in it, while the tools are usable, for other tools that work there. */
	readonly workspace: (TurnComputer & { readonly place: Place }) | undefined;
	/** Whether the computer's provider signs its requests in, outside it. */
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

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ComputerTools",
) {}

export const make = Effect.gen(function* () {
	const providers = yield* ComputerProviderRepository.Service;
	const projectComputers = yield* ProjectComputers.Service;
	const computers = yield* Computers.Service;
	const network = yield* ComputerNetwork.Service;
	const files = yield* ConversationFiles.Service;
	const ids = yield* Ids.Service;
	const operation = yield* serviceOperations<Interface>("ComputerTools");
	const offeredIn = ({
		turnId,
		conversationId,
		place,
		acceptsImages,
		openComputer,
		browser,
		run,
		blocked,
		allowlisted,
		attach,
	}: Behind): Pick<Offered, "tools" | "requests"> => {
		const computer: TurnComputer = { open: openComputer, run };
		return {
			tools: {
				[RUN_COMMAND_TOOL]: runCommandTool(computer, place),
				[READ_FILE_TOOL]: readFileTool(computer, place, acceptsImages),
				[WRITE_FILE_TOOL]: writeFileTool(computer, place),
				[COPY_FILE_TO_COMPUTER_TOOL]: copyFileToComputerTool({
					computer,
					place,
					conversationId,
					files,
					ids,
				}),
				...(attach ? { [SHARE_FILE_TOOL]: shareFileTool(computer, place, attach) } : {}),
				...browserTools(browser, acceptsImages),
			},
			requests: allowlisted
				? { [REQUEST_NETWORK_ACCESS_TOOL]: requestNetworkAccess({ turnId, network, blocked, run }) }
				: {},
		};
	};
	return Service.of({
		forTurn: (turn) =>
			Effect.gen(function* (): Effect.fn.Return<Offered, never, Scope.Scope> {
				const {
					workspaceId,
					projectId,
					turnId,
					conversationId,
					botId,
					acceptsImages,
					usesComputer,
					attach,
				} = turn;
				const place = placeOf({ conversationId, botId });
				const provider =
					usesComputer && projectId !== null ? yield* providers.enabled(workspaceId) : undefined;
				if (!provider || projectId === null) {
					return {
						...offeredIn({
							turnId,
							conversationId,
							place,
							acceptsImages,
							attach,
							openComputer: NEVER_OPENED,
							browser: browserSession({ open: NEVER_OPENED, run: NEVER_RUN }, place, turn),
							run: NEVER_RUN,
							blocked: [],
							allowlisted: true,
						}),
						usable: false,
						note: NO_COMPUTER_NOTE,
						workspace: undefined,
						signsIn: false,
					};
				}
				const project = { workspaceId, projectId };
				const [reach, blocked, disk] = yield* operation(
					"forTurn",
					Effect.all([
						reachOf(project, computers.forConnection(provider.connection)),
						blockedHostsOf(workspaceId),
						projectComputers.diskOf(project),
					]),
				);
				const holder: ProjectComputers.Holder = { kind: "turn", id: turnId };
				yield* Effect.addFinalizer(() => projectComputers.release(holder));
				yield* Effect.forkScoped(
					projectComputers
						.renew(holder)
						.pipe(Effect.delay(ProjectComputers.LEASE_RENEWAL), Effect.forever),
				);
				// The tools run as promises, with the turn's services.
				const run = effectRunner<never>({
					runPromiseExit: Effect.runPromiseExitWith(yield* Effect.context<never>()),
				});
				// Opening the computer serves every call in the turn, so it stops when
				// the turn ends rather than with the call that started it.
				const turnEnded = yield* Effect.abortSignal;
				const prepared = projectComputers.open(project, provider, holder).pipe(
					// The folders are made on first use, so any computer gains them.
					Effect.tap(({ computer }) =>
						computer.exec(`mkdir -p '${place.folder}' '${place.home}'`, {
							timeout: "30 seconds",
							maxOutputCharacters: 2_000,
						}),
					),
				);
				const openComputer = openOncePerTurn(() => run(prepared, { signal: turnEnded }));
				const browser = browserSession({ open: openComputer, run }, place, turn);
				yield* Effect.addFinalizer(() => Effect.promise(() => browser.close()));
				return {
					...offeredIn({
						turnId,
						conversationId,
						place,
						acceptsImages,
						attach,
						openComputer,
						browser,
						run,
						blocked: blocked.map((row) => row.host),
						allowlisted: reach.kind === "allowlist",
					}),
					usable: true,
					note: [networkNote(reach), diskNote(disk)]
						.filter((line) => line !== undefined)
						.join("\n\n"),
					workspace: { open: openComputer, run, place },
					signsIn: computers.forConnection(provider.connection).capabilities.credentials !== "none",
				};
			}),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		ProjectComputers.layer,
		Computers.layer,
		ComputerNetwork.layer,
		ComputerProviderRepository.layer,
		ConversationFiles.layer,
	]),
);

/** What a turn's tools work through. */
interface Behind {
	readonly turnId: string;
	readonly conversationId: string;
	readonly place: Place;
	readonly acceptsImages: boolean;
	readonly openComputer: OpenComputer;
	readonly browser: BrowserSession;
	readonly run: RunEffect<never>;
	/** Hosts a request is refused for without asking anyone. */
	readonly blocked: readonly string[];
	/** Whether the computer reaches only the hosts allowed it, so the bot may ask for more. */
	readonly allowlisted: boolean;
	readonly attach: AttachToReply | undefined;
}

// Behind tools that aren't usable, whose calls are refused before they run.
const NEVER_OPENED: OpenComputer = () =>
	Promise.reject(new Error("The computer tools aren't usable"));
const NEVER_RUN: RunEffect<never> = () =>
	Promise.reject(new Error("The computer tools aren't usable"));

const NO_COMPUTER_NOTE =
	"You have no computer in this turn, so calls to the computer tools are refused. If the thread needs one, say so: a workspace admin can enable a computer provider and let you use one.";

/** A turn that may use the computer of the project it works in. */
export interface Turn {
	readonly workspaceId: string;
	/** The project whose computer the turn uses; none for a turn that works in no project. */
	readonly projectId: string | null;
	/** Whether an admin let the turn's bot use computers. */
	readonly usesComputer: boolean;
	/** Holds the computer's lease while the turn runs. */
	readonly turnId: string;
	readonly conversationId: string;
	readonly botId: string;
	/** The bot's colour, which its desktop is drawn in. */
	readonly color: BotColor;
	/** Whether the bot browses so people watching its desktop can follow. */
	readonly naturalBrowsing: boolean;
	/** Whether the bot's model takes images, which results then may carry. */
	readonly acceptsImages: boolean;
	/**
	 * Attaches a file to the turn's reply, where people can be shown it. Given
	 * only for a turn in a thread (`project_thread`), because a thread serves
	 * the files in it to its project's people; a run, collaboration or
	 * automation feed has no page that shows a reply's files. Without it, the
	 * turn has no `share_file`.
	 */
	readonly attach?: AttachToReply;
}

/** No computer tools, for cases that offer none. */
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
