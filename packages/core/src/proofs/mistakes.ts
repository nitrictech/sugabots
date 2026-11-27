/**
 * Near-misses with proofs, principals and tiers, one per line under
 * `@ts-expect-error`. Type-checked and never run or imported. The lint check
 * reads each directive's TS code and bracketed message fragment to verify
 * that the line fails for the intended reason.
 *
 * The proofs and services here are stand-ins with the shapes the real ones
 * take, declared so the checks don't depend on any one prover.
 *
 * The Effect language service's own reports of an undeclared error or
 * service, and of an error typed `unknown`, are off here, as
 * `@ts-expect-error` doesn't silence them and the mistake is the point.
 */
// @effect-diagnostics missingEffectError:off missingEffectContext:off anyUnknownInErrorContext:off

import type { ComputerMadeMeanwhile } from "@sugabots/contracts/errors/computers";
import type { NotInWorkspace } from "@sugabots/contracts/errors/projects";
import type { SubscriptionInUse } from "@sugabots/contracts/errors/workspace";
import { type InputOf, OperationContract } from "@sugabots/contracts/operations";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "@sugabots/contracts/operations/web";
import { Context, Effect, Layer, Schema } from "effect";
import type { Usage } from "../accounting/usage.ts";
import type { Accounts } from "../accounts/accounts.ts";
import type { WorkspaceGuide } from "../chats/assistant/workspace-guide.ts";
import type { AutomationRunner } from "../chats/automations/automation-runner.ts";
import type { Automations } from "../chats/automations/automations.ts";
import type { ProjectAutomations } from "../chats/automations/project-automations.ts";
import type { AutomationStore } from "../chats/automations/store.ts";
import type { ChatDetailsView } from "../chats/chat-details-view.ts";
import type { ChatFiles } from "../chats/chats/chat-files.ts";
import type { ChatView } from "../chats/chats/chat-view.ts";
import type { Chats } from "../chats/chats/chats.ts";
import type { FloorControl } from "../chats/floor/floor-control.ts";
import type { Reactions } from "../chats/reactions/reactions.ts";
import type { DesktopViewer } from "../chats/tools/browser/viewer.ts";
import type { TurnComputers } from "../chats/tools/computer/turn-computers.ts";
// biome-ignore lint/style/noRestrictedImports: Type-checks the store without exporting it from Turns.
import type { TurnStore } from "../chats/turns/store.ts";
// biome-ignore lint/style/noRestrictedImports: Type-checks the store without exporting it from Turns.
import type { ToolCallStore } from "../chats/turns/tool-calls/store.ts";
import type { Turns } from "../chats/turns/turns.ts";
import type { ComputerNetwork } from "../computers/computer-network.ts";
import type { ComputerProviderSetup } from "../computers/computer-provider-setup.ts";
import type { ProjectComputerSetup } from "../computers/project-computer-setup.ts";
import type { ProjectComputers } from "../computers/project-computers.ts";
import { Transaction } from "../database/database.ts";
import type { Files } from "../files/files.ts";
import type { FilePages } from "../files/pages.ts";
import type { Notifications } from "../notifications/notifications.ts";
import { type Call, defineOperation } from "../operations/operation.ts";
import { managingWorkspace, readingWorkspace } from "../operations/workspace-openings.ts";
import type {
	BotForAsker,
	MemberSession,
	PageAddress,
	Principal,
	SystemWork,
} from "../principal.ts";
import type { ConnectorCalls } from "../providers/connectors/connector-calls.ts";
import type { Connectors } from "../providers/connectors/connectors.ts";
import type { GitHubApps } from "../providers/connectors/github/github-app.ts";
import type { GitHubConnectors } from "../providers/connectors/github/github-connectors.ts";
import type { GitHubUninstalls } from "../providers/connectors/github/uninstalls.ts";
import type { ModelProviders } from "../providers/model-providers/model-providers.ts";
import type { SearchProviders } from "../providers/search-providers/search-providers.ts";
import type { Web } from "../providers/web/web.ts";
import type { Streams } from "../streams/streams.ts";
import { processLayer, Tier } from "../tiers.ts";
import type { Bots } from "../workspaces/bots/bots.ts";
import type { Membership } from "../workspaces/membership/membership.ts";
import type { Projects } from "../workspaces/projects/projects.ts";
import type { WorkspaceTimeZone } from "../workspaces/time-zone/workspace-time-zone.ts";
import type { WorkspaceSetup } from "../workspaces/workspace-setup/workspace-setup.ts";
import { proveActsForMember } from "./acts-for-member.ts";
import type { Approved as RecordedApproval } from "./approved.ts";
import { proveCanChangeBotReach, proveCanDeleteBot } from "./bot-permissions.ts";
import { proveCallsWebhook } from "./calls-webhook.ts";
import { proveCanCancelInvitation } from "./can-cancel-invitation.ts";
import { proveCanDecide } from "./can-decide.ts";
import { proveCanManageBot } from "./can-manage-bot.ts";
import { proveCanRestrictBot, proveCanRestrictBotsProject } from "./can-restrict-bot.ts";
import { proveCanUseChatComputer } from "./can-use-computer.ts";
import type { CanUseConnector } from "./can-use-connector.ts";
import { proveCanUseWeb } from "./can-use-web.ts";
import { proveCanManageChats } from "./chat-permissions.ts";
import {
	proveDeletionRecorded,
	proveProjectDeletionRecorded,
	proveWorkspaceDeletionStarted,
} from "./deletion-started.ts";
import type { DoesStoredWork } from "./does-stored-work.ts";
import { proveEndsTurn } from "./ends-turn.ts";
import { proveInWorkspace as proveRealInWorkspace } from "./in-workspace.ts";
import { proveIsMember } from "./is-member.ts";
import { proveCanChangeMembership, proveCanDeleteWorkspace } from "./membership-changes.ts";
import {
	proveCanChangeAllowedHosts,
	proveCanChangeProjectMembers,
	proveCanReadConnectors,
	proveCanRunAutomations,
	proveCanChangeChat as proveRealCanChangeChat,
	proveCanManageProject as proveRealCanManageProject,
	proveCanTakePart as proveRealCanTakePart,
} from "./project-permissions.ts";
import { defineProof, type Named, named, type Proof } from "./proof.ts";
import { proveReachSet } from "./reach-set.ts";
import { proveReachesAutomation } from "./reaches-automation.ts";
import { proveReachesAutomationTrigger } from "./reaches-automation-trigger.ts";
import { proveReachesBot } from "./reaches-bot.ts";
import { proveReachesChat as proveRealReachesChat } from "./reaches-chat.ts";
import { proveReachesComputerProvider } from "./reaches-computer-provider.ts";
import { proveReachesConnector } from "./reaches-connector.ts";
import {
	proveOwnsUnsentAttachment,
	proveReachesFile,
	proveReachesMessageFile,
} from "./reaches-file.ts";
import { proveReachesMessage } from "./reaches-message.ts";
import { proveReachesModelProvider } from "./reaches-model-provider.ts";
import { proveReachesPage } from "./reaches-page.ts";
import { proveReachesProject as proveRealReachesProject } from "./reaches-project.ts";
import {
	proveReachesProjectAutomation,
	proveRestrictableAutomation,
} from "./reaches-project-automation.ts";
import { proveReachesSearchProvider } from "./reaches-search-provider.ts";
import { proveReachesSetupBot } from "./reaches-setup-bot.ts";
import { proveRunsTurn, type RunsTurn } from "./runs-turn.ts";
import { proveSignedByGitHubApp } from "./signed-by-github-app.ts";
import { proveCanInterrupt, proveCanSteer } from "./turn-control.ts";
import { underWorkspaceLock } from "./workspace-lock.ts";
import {
	type CanManageWorkspace,
	proveCanManageWorkspace,
	proveCanReadWorkspace,
} from "./workspace-permissions.ts";

const proveRealApproved = <
	P,
	X,
	N extends Exclude<ApprovedOperation, "connectors.callTool">,
	const Targets extends [unknown, ...unknown[]],
>(
	principal: Named<P, Principal>,
	call: Named<X, Call>,
	rule: ApprovalRule<OrdinaryApproval, N>,
	input: InputOf<NoInfer<N>>,
	...targets: { [Index in keyof Targets]: Named<Targets[Index], string> }
) =>
	named(input, <I>(input: Named<I, InputOf<NoInfer<N>>>) =>
		proveNamedApproval<P, X, N, I, Targets>(principal, call, rule, input, ...targets),
	);

interface ReachesProject<P, J> extends Proof<"ReachesProject", [P, J]> {
	readonly project: Named<J, string>;
}
interface ReachesChat<P, C> extends Proof<"ReachesChat", [P, C]> {
	readonly chat: Named<C, string>;
}
interface CanTakePart<P, C> extends Proof<"CanTakePart", [P, C]> {
	readonly reach: ReachesChat<P, C>;
}
interface CanChangeChat<P, C> extends Proof<"CanChangeChat", [P, C]> {
	readonly reach: ReachesChat<P, C>;
}
interface CanManageProject<P, J> extends Proof<"CanManageProject", [P, J]> {
	readonly reach: ReachesProject<P, J>;
}
interface InWorkspace<P, W> extends Proof<"InWorkspace", [P, W]> {
	readonly role: "owner" | "admin" | "editor" | "viewer";
}
interface Approved<P, X> extends Proof<"Approved", [P, X]> {}

declare const chats: {
	readonly setResolved: <P, C>(
		reach: ReachesChat<P, C>,
		resolved: boolean,
		access: CanTakePart<P, C>,
	) => Effect.Effect<void>;
	readonly rename: <P, C>(
		chat: Named<C, string>,
		access: CanChangeChat<P, C>,
	) => Effect.Effect<void>;
	readonly post: <P, C>(chat: Named<C, string>, access: CanTakePart<P, C>) => Effect.Effect<void>;
};
declare const projects: {
	readonly archive: <P, J>(
		reach: ReachesProject<P, J>,
		access: CanManageProject<P, J>,
	) => Effect.Effect<void>;
};
declare const memberships: {
	readonly promote: <P, W>(membership: InWorkspace<P, W>) => Effect.Effect<void>;
};
declare const toolCalls: {
	readonly run: <P, X>(call: Named<X, string>, approved: Approved<P, X>) => Effect.Effect<void>;
};
declare const proveReachesChat: <P, C>(
	principal: Named<P, Principal>,
	chat: Named<C, string>,
) => Effect.Effect<ReachesChat<P, C>>;
declare const proveReachesProject: <P, J>(
	principal: Named<P, Principal>,
	project: Named<J, string>,
) => Effect.Effect<ReachesProject<P, J>>;
declare const proveCanTakePart: <P, C>(reach: ReachesChat<P, C>) => CanTakePart<P, C>;
declare const proveCanManageProject: <P, J>(reach: ReachesProject<P, J>) => CanManageProject<P, J>;
declare const proveInWorkspace: <P, W>(
	principal: Named<P, Principal>,
	workspace: Named<W, string>,
) => Effect.Effect<InWorkspace<P, W>>;
declare const proveApproved: <P, X>(
	principal: Named<P, Principal>,
	call: Named<X, string>,
) => Effect.Effect<Approved<P, X>>;

declare const principal: Principal;
declare const chatId: string;
declare const otherChatId: string;

// What `defineProof` makes fits the proof's interface, for the same names only.
const ReachesChatProof = defineProof("ReachesChat");
export const proveHere = <P, C>(principal: Named<P, Principal>, chat: Named<C, string>) => {
	const proof: ReachesChat<P, C> = ReachesChatProof.prove([principal, chat], { chat });
	// @ts-expect-error TS2322 [Type 'Proof<"ReachesChat", [P, C]> & Readonly<{ chat: Named<C, string>; }>' is not assignable to type 'Reaches] Swapping the names changes which principal reaches which chat.
	const swapped: ReachesChat<C, P> = ReachesChatProof.prove([principal, chat], { chat });
	// @ts-expect-error TS2322 [Type 'Proof<"ReachesChat", [P, C]> & Readonly<{ reach: ReachesChat<P, C>; }>' is not assignable to type 'CanTa] Reach cannot stand in for permission to take part.
	const otherKind: CanTakePart<P, C> = ReachesChatProof.prove([principal, chat], { reach: proof });
	return [proof, swapped, otherKind];
};

export const mistakes = named(principal, chatId, otherChatId, (principal, chatA, chatB) =>
	Effect.gen(function* () {
		const reachA = yield* proveReachesChat(principal, chatA);
		const reachB = yield* proveReachesChat(principal, chatB);
		const canTakePartA = proveCanTakePart(reachA);

		// A raw chat id handed to a service that wants a named one.
		// @ts-expect-error TS2345 [Argument of type 'string' is not assignable to parameter of type 'Named<NameB, string>']
		yield* chats.rename(chatId, canTakePartA);

		// A proof about chat A used for chat B.
		// @ts-expect-error TS2345 [Argument of type 'CanTakePart<NameA, NameB>' is not assignable to parameter of type 'CanTakePart<NameA, NameC>']
		yield* chats.setResolved(reachB, true, canTakePartA);

		// `CanTakePart` where `CanChangeChat` is needed.
		// @ts-expect-error TS2345 [Argument of type 'CanTakePart<NameA, NameB>' is not assignable to parameter of type 'CanChangeChat<NameA, NameB>']
		yield* chats.rename(chatA, canTakePartA);

		// A spread copy of a named value, with another value.
		// @ts-expect-error TS2739 [from type 'Named<NameB, string>']
		yield* chats.post({ ...chatA, value: otherChatId }, canTakePartA);

		yield* chats.post(chatA, canTakePartA);

		yield* chats.setResolved(reachA, true, canTakePartA);
	}),
);

export const membershipMistakes = named(principal, "workspace", (principal, workspace) =>
	Effect.gen(function* () {
		const membership = yield* proveInWorkspace(principal, workspace);

		// A spread copy of `InWorkspace` with another role.
		// @ts-expect-error TS2739 [from type 'InWorkspace<NameA, NameB>']
		yield* memberships.promote({ ...membership, role: "owner" });

		yield* memberships.promote(membership);
	}),
);

// A named value returned out of `named`.
// @ts-expect-error TS2322 [Type 'Effect<Named<NameA, string>, never, never>' is not assignable to type 'Effect<Named<unknown, string>, ne]
export const escaped = named(chatId, (chat) => Effect.succeed(chat));

declare const memberOnly: (principal: MemberSession) => Effect.Effect<void>;
declare const botForAsker: BotForAsker;

// A `MemberSession`-only operation called with a `BotForAsker`.
// @ts-expect-error TS2739 [from type 'MemberSession']
export const botAsMember = memberOnly(botForAsker);

// Building a `Principal` literal.
// @ts-expect-error TS2739 [from type 'MemberSession']
export const forged: MemberSession = { _tag: "MemberSession", member: "someone" };

declare const session: MemberSession;
// A spread copy of a principal, with another member.
// @ts-expect-error TS2739 [from type 'MemberSession']
export const copied: MemberSession = { ...session, member: "someone else" };

// A spread copy of a bot's principal, with wider bounds.
// @ts-expect-error TS2739 [from type 'BotForAsker']
export const widened: BotForAsker = { ...botForAsker, bounds: { kind: "member" } };

// Building system work naming another chat.
// @ts-expect-error TS2741 [required in type 'SystemWork']
export const forgedWork: SystemWork = {
	_tag: "SystemWork",
	workspace: "workspace",
	work: { kind: "compaction", chat: "someone else's chat" },
};

declare const page: PageAddress;
// A spread copy of a page address, opening another page.
// @ts-expect-error TS2739 [from type 'PageAddress']
export const otherPage: PageAddress = { ...page, file: "another file" };

class CurrentRequest extends Context.Service<CurrentRequest, { readonly id: string }>()(
	"@sugabots/core/mistakes/CurrentRequest",
) {
	declare readonly [Tier]: "request";
}
class Registry extends Context.Service<Registry, { readonly size: number }>()(
	"@sugabots/core/mistakes/Registry",
) {
	declare readonly [Tier]: "process";
}
class Lookup extends Context.Service<Lookup, { readonly describe: Effect.Effect<void> }>()(
	"@sugabots/core/mistakes/Lookup",
) {
	declare readonly [Tier]: "process";
}

// `processLayer` over a layer that needs a request-tier service.
export const capturesRequest = processLayer(
	// @ts-expect-error TS2345 [parameter of type 'Layer<Lookup, never, CurrentRequest> & { readonly "built per worksp] The layer that builds Lookup reads a request-tier service.
	Layer.effect(
		Lookup,
		Effect.gen(function* () {
			const request = yield* CurrentRequest;
			return { describe: Effect.log(request.id) };
		}),
	),
);

// The same layer wrapped with `pipe`, which leaves a long layer's body where it was.
export const capturesRequestPiped = Layer.effect(
	Lookup,
	Effect.gen(function* () {
		const request = yield* CurrentRequest;
		return { describe: Effect.log(request.id) };
	}),
).pipe(
	// @ts-expect-error TS2345 [parameter of type '(_: Layer<Lookup, never, CurrentRequest>) => Layer<Lookup, never, C] Piping through processLayer still rejects the request dependency.
	processLayer,
);

export const processOnly = processLayer(
	Layer.effect(
		Lookup,
		Effect.gen(function* () {
			const registry = yield* Registry;
			return { describe: Effect.log(registry.size) };
		}),
	),
);

// A layer that provides a request-tier service, built from a whole context.
export const providesRequest = processLayer(
	// @ts-expect-error TS2345 [parameter of type 'Layer<CurrentRequest, never, never> & { readonly "built per workspa] A whole context cannot hide a request-tier service.
	Layer.succeedContext(Context.make(CurrentRequest, { id: "one request's" })),
);

// The database's open transaction is request tier too, however it is imported.
export const providesTransaction = processLayer(
	// @ts-expect-error TS2345 [parameter of type 'Layer<Transaction, never, never> & { readonly "built per workspace ] The context contains the request's open transaction.
	Layer.succeedContext(
		Context.make(Transaction, { beforeCommit: [], batches: new Map(), afterCommit: [] }),
	),
);

// An outer `Layer.unwrap` that reads a request-tier service while choosing a layer
// that is fine itself.
export const choosesWhileReadingRequest = processLayer(
	// @ts-expect-error TS2345 [parameter of type 'Layer<Lookup, never, CurrentRequest> & { readonly "built per worksp] The outer layer reads the request while choosing a process layer.
	Layer.unwrap(
		Effect.gen(function* () {
			const request = yield* CurrentRequest;
			return processLayer(
				Layer.effect(Lookup, Effect.succeed({ describe: Effect.log(request.id) })),
			);
		}),
	),
);

export const choosesWhileReadingProcess = processLayer(
	Layer.unwrap(
		Effect.gen(function* () {
			const registry = yield* Registry;
			return processLayer(
				Layer.effect(Lookup, Effect.succeed({ describe: Effect.log(registry.size) })),
			);
		}),
	),
);

// `Layer.fromBuild` and `Layer.effectDiscard`, which take no service to build.
export const buildsFromRequest = processLayer(
	// @ts-expect-error TS2345 [parameter of type 'Layer<Lookup, never, CurrentRequest> & { readonly "built per worksp] The build needs a request even though its output is process-tier.
	Layer.fromBuild(() =>
		Effect.map(CurrentRequest, (request) =>
			Context.make(Lookup, { describe: Effect.log(request.id) }),
		),
	),
);

export const discardsAfterRequest = processLayer(
	// @ts-expect-error TS2345 [parameter of type 'Layer<never, never, CurrentRequest> & { readonly "built per workspa] Discarding the result does not remove the request dependency.
	Layer.effectDiscard(Effect.flatMap(CurrentRequest, (request) => Effect.log(request.id))),
);

const setResolved = OperationContract.make("chats.setResolved", {
	description: "Mark this chat resolved, or reopen it.",
	input: Schema.Struct({ chatId: Schema.String, resolved: Schema.Boolean }),
	output: Schema.Void,
	errors: [],
	changes: true,
	http: { kind: "heldBack", reason: "Stand-in." },
	botLoop: { kind: "heldBack", reason: "Stand-in." },
});

// An operation's body failing with an error its contract doesn't list.
// @ts-expect-error TS2322 [Type 'Effect<never, string, never>' is not assignable to type 'Effect<void, never, never>']
export const undeclaredError = defineOperation(setResolved, () => Effect.fail("refused"));

// An operation's body reading an input field its contract doesn't have.
// @ts-expect-error TS2339 [Property 'chatName' does not exist on type '{ readonly chatId: string; readonly resolved: boolean; }']
export const unknownInput = defineOperation(setResolved, (_, input) => Effect.log(input.chatName));

export const declared = defineOperation(setResolved, (_, input) => Effect.log(input.chatId));

export const assumesToolCall = defineOperation(setResolved, (_, __, call) =>
	// An operation's body reading a tool call's id from a call that may be an HTTP request.
	// @ts-expect-error TS2339 [Property 'toolCall' does not exist on type 'Call']
	Effect.log(call.toolCall),
);

declare const projectsService: Projects.Interface;
declare const projectCall: { readonly kind: "request"; readonly request: string };
declare const otherPrincipal: Principal;

export const projectsServiceMistakes = underWorkspaceLock(principal, "workspace", (lock) =>
	named(otherPrincipal, "project", "bot", "member", (other, project, bot, member) =>
		named(projectCall, (call) =>
			Effect.gen(function* () {
				const reach = yield* proveRealReachesProject(lock.principal, project);
				const canChange = yield* proveCanChangeProjectMembers(lock, reach);
				const addBotApproval = approvalRule("projects.addBot");
				const input = { projectId: project.value, botId: bot.value };
				const approved = yield* proveRealApproved(
					lock.principal,
					call,
					addBotApproval,
					input,
					project,
					bot,
				);
				const approvedForOther = yield* proveRealApproved(
					other,
					call,
					addBotApproval,
					input,
					project,
					bot,
				);

				// A project's members changed with a reach proved for a principal named outside the lock.
				// @ts-expect-error TS2345 [Argument of type 'ReachesProject<NameA, NameB>' is not assignable to parameter of type 'ReachesProject<P, NameB>']
				yield* proveCanChangeProjectMembers(lock, yield* proveRealReachesProject(other, project));

				// A bot proven reached by another principal, added to a project this one may change.
				const reachedByOther = yield* proveReachesBot(other, bot);
				// @ts-expect-error TS2345 [Argument of type 'ReachesBot<NameA, NameC>' is not assignable to parameter of type 'ReachesBot<P, NameC>']
				yield* projectsService.addBot(lock, canChange, reachedByOther, approved);

				// A bot added for a bot's call another principal's approval allowed.
				const reachesBot = yield* proveReachesBot(lock.principal, bot);
				// @ts-expect-error TS2345 [Argument of type 'HoldsWorkspaceLock<P, W>' is not assignable to parameter of type 'HoldsWorkspaceLock<NameA, W>'] The approval belongs to a different principal.
				yield* projectsService.addBot(lock, canChange, reachesBot, approvedForOther);

				// A project deleted with the proof that its members may be changed, not that it may be deleted.
				// @ts-expect-error TS2739 [from type 'ProjectDeletionStarted<unknown, unknown, "project">']
				yield* projectsService.remove(canChange);

				// A project's members listed with no proof that it is reached, only its id.
				// @ts-expect-error TS2740 [from type 'ReachesProject<unknown, unknown>']
				yield* projectsService.members(project);

				// A member added by a write taken out of the transaction that holds the lock.
				// @ts-expect-error TS2322 [Type 'Effect<void, NotInWorkspace, Transaction>' is not assignable to type 'Effect<void, NotInWorkspace, never]
				const outsideTheLock: Effect.Effect<void, NotInWorkspace> = projectsService.addMember(
					canChange,
					member,
				);

				yield* outsideTheLock;
				yield* projectsService.addMember(canChange, member);
				yield* projectsService.addBot(
					lock,
					canChange,
					yield* proveReachesBot(lock.principal, bot),
					approved,
				);
				yield* projectsService.members(reach);
			}),
		),
	),
);

declare const computerProviderSetup: ComputerProviderSetup.Interface;
declare const computerNetwork: ComputerNetwork.Interface;
declare const projectComputerSetup: ProjectComputerSetup.Interface;

export const computersServiceMistakes = named(
	principal,
	"workspace",
	"project",
	(principal, workspace, project) =>
		Effect.gen(function* () {
			const inWorkspace = yield* proveRealInWorkspace(principal, workspace);
			const canRead = yield* proveCanReadWorkspace(inWorkspace);
			const canManageWorkspace = yield* proveCanManageWorkspace(inWorkspace);
			const reach = yield* proveRealReachesProject(principal, project);
			const canManage = yield* proveRealCanManageProject(reach);

			// A workspace's computer providers listed by whoever may read the workspace, not manage it.
			// @ts-expect-error TS2345 [Argument of type 'CanReadWorkspace<NameA, NameB>' is not assignable to parameter of type 'CanManageWorkspace<NameA, NameB>']
			yield* computerProviderSetup.list(canRead);

			// A project's allowed hosts changed by its managers outside member bounds, with `CanManageProject`.
			// @ts-expect-error TS2345 [Argument of type 'CanManageProject<NameA, NameC>' is not assignable to parameter of type 'CanChangeAllowedHosts<NameA, NameC>']
			yield* computerNetwork.addProjectHost(canManage, "example.com");

			// A project's computer reset by whoever reaches the project, not whoever manages it.
			// @ts-expect-error TS2739 [from type 'CanManageProject<unknown, unknown>']
			yield* projectComputerSetup.reset(reach);

			yield* computerProviderSetup.list(canManageWorkspace);
			yield* computerProviderSetup.access(canRead);
			yield* projectComputerSetup.reset(canManage);
			yield* computerNetwork.projectSettings(reach);
			yield* computerNetwork.addProjectHost(
				yield* proveCanChangeAllowedHosts(reach),
				"example.com",
			);
		}),
);

declare const guides: WorkspaceGuide.Interface;
declare const modelProvidersService: ModelProviders.Interface;
declare const searchProvidersService: SearchProviders.Interface;

export const providersServiceMistakes = named(
	principal,
	"workspace",
	"provider",
	(principal, workspace, provider) =>
		Effect.gen(function* () {
			const inWorkspace = yield* proveRealInWorkspace(principal, workspace);
			const canRead = yield* proveCanReadWorkspace(inWorkspace);
			const canManage = yield* proveCanManageWorkspace(inWorkspace);
			const reach = proveReachSet(inWorkspace);

			// @ts-expect-error TS2554 [Expected 3 arguments, but got 2.] The workspace guide needs the approval proof for the call.
			yield* guides.guide(canRead, reach);

			// A provider's key changed with the proof that the workspace may be read, not that its providers may be managed.
			// @ts-expect-error TS2739 [from type 'ReachesModelProvider<unknown, unknown, unknown>']
			yield* modelProvidersService.update(canRead, { apiKey: "key" });

			// A search provider removed with no proof, only the workspace's id.
			// @ts-expect-error TS2740 [from type 'ReachesSearchProvider<unknown, unknown>']
			yield* searchProvidersService.remove(workspace);

			yield* modelProvidersService.update(yield* proveReachesModelProvider(canManage, provider), {
				apiKey: "key",
			});
			yield* modelProvidersService.listEnabledModels(canRead);
			yield* searchProvidersService.remove(yield* proveReachesSearchProvider(canManage));
		}),
);

declare const botsService: Bots.Interface;

export const botsServiceMistakes = named(
	principal,
	otherPrincipal,
	"bot",
	(principal, other, bot) =>
		named(projectCall, (call) =>
			Effect.gen(function* () {
				const canManage = yield* proveCanManageBot(principal, bot);
				const canRestrict = yield* proveCanRestrictBot(principal, bot);
				const reach = yield* proveReachesBot(principal, bot);
				const otherActsForMember = yield* proveActsForMember(other);
				const approved = yield* proveRealApproved(
					principal,
					call,
					approvalRule("bots.pin"),
					{
						botId: bot.value,
					},
					bot,
				);

				// A bot deleted with the proof that it may be managed, not that it may be deleted.
				// @ts-expect-error TS2345 [Argument of type 'CanManageBot<NameA, NameC>' is not assignable to parameter of type 'CanDeleteBot<unknown, unknown>']
				yield* botsService.beginRemoval(canManage);

				// A bot deleted with the proof that it may be restricted, not that it may be deleted.
				// @ts-expect-error TS2345 [Argument of type 'CanRestrictBot<NameA, NameC>' is not assignable to parameter of type 'CanDeleteBot<unknown, unknown>']
				yield* botsService.beginRemoval(canRestrict);

				// A bot changed with the proof that an admin may restrict it, which changes nothing of it.
				// @ts-expect-error TS2345 [Argument of type 'CanRestrictBot<NameA, NameC>' is not assignable]
				yield* botsService.update(canRestrict, {});

				// A bot pinned for one principal with another's proof that it reaches it.
				// @ts-expect-error TS2345 [Argument of type 'ActsForMember<NameB>' is not assignable to parameter of type 'ActsForMember<NameA>']
				yield* botsService.setPinned(otherActsForMember, reach, true, approved);

				// A bot pinned with no proof the call was approved.
				// @ts-expect-error TS2554 [Expected 4 arguments, but got 3.]
				yield* botsService.setPinned(yield* proveActsForMember(principal), reach, true);

				yield* botsService.setPinned(yield* proveActsForMember(principal), reach, true, approved);
			}),
		),
);

export const botDeletionMistakes = underWorkspaceLock(principal, "workspace", (lock) =>
	named(otherPrincipal, "bot", (other, bot) =>
		Effect.gen(function* () {
			const canManage = yield* proveCanManageBot(lock.principal, bot);
			const canRestrict = yield* proveCanRestrictBot(lock.principal, bot);
			const managedOutside = yield* proveCanManageBot(other, bot);

			// A bot deleted with an authority proved for a principal named outside the lock.
			// @ts-expect-error TS2345 [Argument of type 'CanManageBot<NameA, NameB>' is not assignable to parameter of type 'CanManageBot<P, NameB> | CanRestrictBot<P, NameB>']
			yield* proveCanDeleteBot(lock, managedOutside);

			// A bot's computer use changed with a reach proof for a principal named outside the lock.
			// @ts-expect-error TS2345 [Argument of type 'CanManageBot<NameA, NameB>' is not assignable to parameter of type 'CanManageBot<P, NameB>']
			yield* botsService.update(yield* proveCanChangeBotReach(lock, managedOutside), {
				usesComputer: true,
			});

			yield* botsService.beginRemoval(yield* proveCanDeleteBot(lock, canManage));
			yield* botsService.beginRemoval(yield* proveCanDeleteBot(lock, canRestrict));
			yield* botsService.update(yield* proveCanChangeBotReach(lock, canManage), {
				usesComputer: true,
			});
		}),
	),
);

declare const automationsService: ProjectAutomations.Interface;

export const projectAutomationsServiceMistakes = named(
	principal,
	"project",
	"automation",
	"other automation",
	(principal, project, automation, otherAutomation) =>
		Effect.gen(function* () {
			const { reach, target } = yield* proveReachesProjectAutomation(
				principal,
				project,
				automation,
			);
			const canManage = yield* proveRealCanManageProject(reach);
			const canRestrict = yield* proveCanRestrictBotsProject(principal, project);

			const member = yield* proveIsMember(principal);
			const settings = { name: "Daily report", instructions: "Write a report.", triggers: [] };
			const routine = {
				kind: "routine",
				schedule: { repeat: "cron", expression: "0 9 * * *" },
				timezone: "UTC",
			} as const;

			// @ts-expect-error TS2739 [from type 'CanManageProject<NameA, unknown>'] Reaching the project does not authorize creating an automation.
			yield* automationsService.create(reach, member, settings);

			// @ts-expect-error TS2740 [from type 'Approved<NameA, unknown, [NameB], "automations.createWithRoutine">'] Creating an automation with a routine requires approval for that call.
			yield* automationsService.createWithRoutine(canManage, member, routine.timezone);

			const { timezone } = routine;
			// @ts-expect-error TS2740 [from type 'Approved<NameA, unknown, [NameB, NameC], "automations.updateInChat">'] Changing an automation from a chat requires approval for that call.
			yield* automationsService.updateInChat(canManage, automation, target, member, timezone);

			yield* automationsService.create(canManage, member, settings);

			// An automation run with the proof that its project may be managed, not that a run may be started there.
			// @ts-expect-error TS2345 [Argument of type 'CanManageProject<NameA, NameB>' is not assignable to parameter of type 'CanRunAutomations<NameA, NameB>']
			yield* automationsService.run(canManage, automation, target, "request");

			// An automation changed at will by an admin who may only switch it off.
			// @ts-expect-error TS2739 [from type 'CanManageProject<NameA, NameB>']
			yield* automationsService.update(canRestrict, automation, target, member, { name: "Mine" });

			// @ts-expect-error TS2345 [parameter of type 'ReachesProjectAutomation<NameA, NameB, NameD>] The target proves reach to a different automation.
			yield* automationsService.remove(canManage, otherAutomation, target);

			yield* automationsService.run(
				yield* proveCanRunAutomations(reach),
				automation,
				target,
				"request",
			);
			const restricted = yield* proveRestrictableAutomation(canRestrict, automation);
			yield* automationsService.switchOff(canRestrict, automation, restricted);
			yield* named("trigger", "other trigger", (trigger, otherTrigger) =>
				Effect.gen(function* () {
					const reached = yield* proveReachesAutomationTrigger(
						principal,
						project,
						automation,
						trigger,
					);
					// @ts-expect-error TS2345 [parameter of type 'ReachesAutomationTrigger<NameA, NameB, NameC, NameB>] The target proves reach to a different trigger.
					yield* automationsService.removeTrigger(canManage, otherTrigger, reached.target);
					yield* automationsService.removeTrigger(canManage, trigger, reached.target);

					// @ts-expect-error TS2740 [from type 'CallsWebhook<unknown, unknown>'] A named trigger does not prove the webhook call reached it.
					yield* automationsService.acceptWebhook(trigger, { headers: {}, payload: {} });

					yield* automationsService.acceptWebhook(yield* proveCallsWebhook(principal, trigger), {
						headers: {},
						payload: {},
					});
				}),
			);
		}),
);

declare const membershipService: Membership.Interface;

export const membershipServiceMistakes = underWorkspaceLock(principal, "workspace", (lock) =>
	named(otherPrincipal, "member", (other, member) =>
		Effect.gen(function* () {
			const canRead = yield* proveCanReadWorkspace(
				yield* proveRealInWorkspace(lock.principal, lock.workspace),
			);
			const canRemove = yield* proveCanChangeMembership(lock, member, { kind: "removal" });
			const otherInWorkspace = yield* proveRealInWorkspace(other, lock.workspace);

			// A workspace deleted with the proof that it may be read, not that its owner deletes it.
			// @ts-expect-error TS2741 [required in type 'DeletionStarted<unknown>']
			yield* membershipService.delete(canRead);

			// A member taken out by a write taken out of the transaction that holds the lock.
			// @ts-expect-error TS2322 [Type 'Effect<{ readonly cleanupPending: boolean; }, SubscriptionInUse, Transaction>' is not assignable to type]
			const outsideTheLock: Effect.Effect<{ cleanupPending: boolean }, SubscriptionInUse> =
				membershipService.beginRemoval(canRemove);

			// A membership changed by a principal proved in the workspace outside the lock, with no lock of its own.
			// @ts-expect-error TS2345 [Argument of type 'InWorkspace<NameA, W>' is not assignable to parameter of type 'HoldsWorkspaceLock<unknown, unknown>']
			yield* proveCanChangeMembership(otherInWorkspace, member, { kind: "removal" });

			// A member's own workspaces listed with only the principal, not the proof a member is signed in.
			// @ts-expect-error TS2740 [from type 'IsMember<unknown>']
			yield* membershipService.workspaces(lock.principal);

			yield* outsideTheLock;
			yield* membershipService.beginRemoval(canRemove);
			yield* membershipService.memberships(canRead);
			yield* membershipService.workspaces(yield* proveIsMember(lock.principal));
		}),
	),
);

declare const notificationsService: Notifications.Interface;

export const notificationsServiceMistakes = named(
	principal,
	otherPrincipal,
	"project",
	(principal, other, project) =>
		Effect.gen(function* () {
			const isMember = yield* proveIsMember(principal);
			const reachedByOther = yield* proveRealReachesProject(other, project);

			// A member's level set in a project another principal was proved to reach.
			// @ts-expect-error TS2345 [Argument of type 'ReachesProject<NameB, NameC>' is not assignable to parameter of type 'PlaceReached<NameA, NameC>']
			yield* notificationsService.setLevel(isMember, reachedByOther, "all");

			// A member's settings read with only the principal, not the proof a member is signed in.
			// @ts-expect-error TS2740 [from type 'IsMember<unknown>']
			yield* notificationsService.settings(principal);

			const reached = yield* proveRealReachesProject(principal, project);
			yield* notificationsService.setLevel(isMember, reached, "all");
		}),
);

export const workspaceDeletionMistakes = underWorkspaceLock(principal, "workspace", (lock) =>
	named(otherPrincipal, (other) =>
		Effect.gen(function* () {
			const canDelete = yield* proveCanDeleteWorkspace(lock);

			// A workspace's deletion proved with no lock, from its owner's place in it.
			// @ts-expect-error TS2345 [Argument of type 'InWorkspace<NameA, W>' is not assignable to parameter of type 'HoldsWorkspaceLock<unknown, unknown>']
			yield* proveCanDeleteWorkspace(yield* proveRealInWorkspace(other, lock.workspace));

			yield* membershipService.beginDeletion(canDelete);
			const started = yield* proveWorkspaceDeletionStarted(lock);
			if (!started) return;

			// A recorded deletion still needs its workspace's lock to finish.
			// @ts-expect-error TS2322 [Type 'Effect<void, ComputerMadeMeanwhile, Transaction>' is not assignable to type 'Effect<void, ComputerMadeMe]
			const outsideTheLock: Effect.Effect<void, ComputerMadeMeanwhile> =
				membershipService.delete(started);

			yield* outsideTheLock;
			yield* membershipService.delete(started);
		}),
	),
);

declare const connectorsService: Connectors.Interface;
declare const gitHubConnectorsService: GitHubConnectors.Interface;
declare const delivery: { event: string; deliveryId: string; body: string };

export const connectorsServiceMistakes = named(
	principal,
	"project",
	"connector",
	"other connector",
	(principal, project, connector, otherConnector) =>
		Effect.gen(function* () {
			const { reach, target } = yield* proveReachesConnector(principal, project, connector);
			const canRead = yield* proveCanReadConnectors(reach);
			const canManage = yield* proveRealCanManageProject(reach);

			// A connector removed with the proof that its project's connectors may be read, not managed.
			// @ts-expect-error TS2741 [required in type 'CanManageProject<NameA, NameB>']
			yield* connectorsService.remove(canRead, connector, target);

			// A project's connectors listed with no proof that they may be read, only that it is reached.
			// @ts-expect-error TS2741 [required in type 'CanReadConnectors<unknown, unknown>']
			yield* connectorsService.list(reach);

			// A delivery read with the proof that its project is reached, not that its GitHub app signed it.
			// @ts-expect-error TS2741 [required in type 'SignedByGitHubApp<unknown, unknown>']
			yield* gitHubConnectorsService.readDelivery(reach, delivery);

			// @ts-expect-error TS2345 [Argument of type 'ReachesConnector<NameA, NameB, NameC>' is not assignable to parameter of type 'ReachesConnector<NameA, NameB, NameD>'] The target proves reach to a different connector.
			yield* connectorsService.remove(canManage, otherConnector, target);
			// @ts-expect-error TS2345 [Argument of type 'string' is not assignable to parameter of type 'Named<NameC, string>'] The raw connector id cannot be bound to the proved target.
			yield* connectorsService.remove(canManage, "connector", target);

			yield* connectorsService.remove(canManage, connector, target);
			yield* connectorsService.list(canRead);
			yield* gitHubConnectorsService.readDelivery(
				yield* proveSignedByGitHubApp(principal, connector),
				delivery,
			);
		}),
);

import {
	type ApprovalRule,
	type ApprovedOperation,
	approvalRule,
	type OrdinaryApproval,
	proveComputerRequestApproved,
	proveApproved as proveNamedApproval,
} from "./approved.ts";

declare const chatsService: Chats.Interface;
declare const posted: { retryKey: string; content: string };
declare const firstPage: { limit: number };
declare const reactionsService: Reactions.Interface;
declare const filesService: Files.Interface;
declare const chatViewService: ChatView.Interface;
declare const turnControls: Turns.ControlsInterface;

export const chatServicesMistakes = named(
	principal,
	otherPrincipal,
	"chat",
	"other chat",
	(principal, other, chat, otherChat) =>
		named({ kind: "request", request: "chat-service-example" } as const, (call) =>
			Effect.gen(function* () {
				const reach = yield* proveRealReachesChat(principal, chat);
				const changesOther = yield* proveRealCanChangeChat(
					yield* proveRealReachesChat(principal, otherChat),
				);
				const canTakePart = yield* proveRealCanTakePart(reach);

				const resolveApproval = approvalRule("chats.setResolved");
				const approved = yield* proveRealApproved(
					principal,
					call,
					resolveApproval,
					{
						chatId: chat.value,
						resolved: true,
					},
					chat,
				);
				const canChange = yield* proveRealCanChangeChat(reach);
				// @ts-expect-error TS2554 [Expected 2 arguments, but got 1.] Writing a file requires approval.
				yield* filesService.create(canChange);
				// @ts-expect-error TS2345 [Argument of type 'CanTakePart<NameA, NameC>' is not assignable to parameter of type 'CanChangeChat<NameA, NameC>'] Taking part does not authorize writing a file.
				yield* filesService.create(canTakePart, approved);
				// @ts-expect-error TS2554 [Expected 2 arguments, but got 1.] Listing written files requires approval.
				yield* filesService.listWritten(reach);
				// @ts-expect-error TS2554 [Expected 3 arguments, but got 2.] Resolving a chat requires approval.
				yield* chatsService.setResolved(reach, canChange);

				// `CanChangeChat` proven for another chat, handed over with the reach of this one.
				// @ts-expect-error TS2345 [Argument of type 'CanChangeChat<NameA, NameD>' is not assignable to parameter of type 'CanChangeChat<NameA, NameC>']
				yield* chatsService.setResolved(reach, changesOther, approved);

				// A message posted as another principal's member, in a chat this one takes part in.
				// @ts-expect-error TS2345 [Argument of type 'CanTakePart<NameA, NameC>' is not assignable to parameter of type 'CanTakePart<NameB, NameC>']
				yield* chatsService.post(yield* proveIsMember(other), canTakePart, posted);

				// A chat renamed with the proof that it may be changed, not that its project's chats may be managed.
				// @ts-expect-error TS2741 [required in type 'CanManageChats<NameA, NameC>']
				yield* chatsService.renameChat(reach, "Renamed", yield* proveRealCanChangeChat(reach));

				// A page of a chat read with the reach of its project, not of the chat.
				// @ts-expect-error TS2741 [required in type 'ReachesChat<unknown, unknown>']
				yield* chatViewService.messages(yield* proveRealReachesProject(principal, chat), firstPage);

				const approvedElsewhere = yield* proveRealApproved(
					principal,
					call,
					resolveApproval,
					{
						chatId: otherChat.value,
						resolved: true,
					},
					otherChat,
				);
				// @ts-expect-error TS2345 [Argument of type 'ReachesChat<NameA, NameC>' is not assignable to parameter of type 'ReachesChat<NameA, NameD>'] The approval targets a different chat.
				yield* chatsService.setResolved(reach, canChange, approvedElsewhere);
				yield* named({}, (unrelated) => {
					// @ts-expect-error TS2345 [parameter of type 'Named<NameA, { readonly chatId: string; readonly resolved: boolean;] The named input must match the operation's input.
					return proveNamedApproval(principal, call, resolveApproval, unrelated, chat);
				});
				const approvedList = yield* proveRealApproved(
					principal,
					call,
					approvalRule("files.listWritten"),
					{},
					chat,
				);
				// @ts-expect-error TS2345 [parameter of type 'Approved<NameA, NameA, [NameC], "chats.setResolved">] Approval to list files cannot authorize resolving a chat.
				yield* chatsService.setResolved(reach, canChange, approvedList);
				yield* chatsService.setResolved(reach, canChange, approved);
				yield* chatsService.post(yield* proveIsMember(principal), canTakePart, posted);
				yield* chatsService.renameChat(reach, "Renamed", yield* proveCanManageChats(reach));
				yield* chatViewService.messages(reach, firstPage);
			}),
		),
);

export const chatFileMistakes = named(
	principal,
	"file",
	"other file",
	"message",
	(principal, file, otherFile, message) =>
		Effect.gen(function* () {
			const reach = yield* proveReachesFile(principal, file);
			const managesOther = yield* proveCanManageChats(
				yield* proveReachesFile(principal, otherFile),
			);
			const isMember = yield* proveIsMember(principal);

			// @ts-expect-error TS2554 [Expected 2 arguments, but got 1.] Reading a written file requires approval.
			yield* filesService.readWritten(reach);

			// A file deleted with the proof that another file's chats may be managed.
			// @ts-expect-error TS2345 [Argument of type 'CanManageChats<NameA, NameC>' is not assignable to parameter of type 'CanManageChats<NameA, NameB>']
			yield* filesService.remove(reach, managesOther);

			// A reaction added with the reach of a chat, not of the message.
			// @ts-expect-error TS2741 [required in type 'ReachesMessage<NameA, NameD>']
			yield* reactionsService.add(isMember, yield* proveRealReachesChat(principal, message), "👍");

			yield* filesService.remove(reach, yield* proveCanManageChats(reach));
			yield* reactionsService.add(isMember, yield* proveReachesMessage(principal, message), "👍");
		}),
);

export const decisionMistakes = named(principal, otherPrincipal, "call", (principal, other, call) =>
	Effect.gen(function* () {
		const isMember = yield* proveIsMember(principal);
		const otherMember = yield* proveIsMember(other);
		const canDecide = yield* proveCanDecide(isMember, call);

		const changesNothing = () => Effect.void;

		// A call decided as another principal's member than the approver `CanDecide` found.
		// @ts-expect-error TS2345 [Argument of type 'CanDecide<NameA, NameC>' is not assignable to parameter of type 'CanDecide<NameB, NameC>']
		yield* turnControls.decide(otherMember, canDecide, "deny", changesNothing);

		// A call decided with no proof that the member is its approver, only its id.
		// @ts-expect-error TS2740 [from type 'CanDecide<NameA, unknown>']
		yield* turnControls.decide(isMember, call, "deny", changesNothing);

		// A host request granted as another member than the approver `CanDecide` found.
		// @ts-expect-error TS2345 [Argument of type 'CanDecide<NameA, NameC>' is not assignable to parameter of type 'CanDecide<NameB, NameC>']
		yield* computerNetwork.grantHostRequest(otherMember, canDecide);

		yield* turnControls.decide(isMember, canDecide, "deny", changesNothing);
		yield* computerNetwork.grantHostRequest(isMember, canDecide);
	}),
);

export const turnControlMistakes = named(
	principal,
	otherPrincipal,
	"chat",
	"turn",
	(principal, other, chat, turn) =>
		Effect.gen(function* () {
			const isMember = yield* proveIsMember(principal);
			const otherMember = yield* proveIsMember(other);
			const reach = yield* proveRealReachesChat(principal, chat);
			const canSteer = yield* proveCanSteer(reach, turn);
			const canInterrupt = yield* proveCanInterrupt(isMember, reach, turn);

			// A turn interrupted with the proof that its asker may steer it, which a manager lacks.
			// @ts-expect-error TS2345 [Argument of type 'CanSteer<NameA, NameD>' is not assignable to parameter of type 'CanInterrupt<NameA, NameD>']
			yield* turnControls.interrupt(canSteer);

			// A turn interrupted with no proof at all, only its id.
			// @ts-expect-error TS2740 [from type 'CanInterrupt<unknown, unknown>']
			yield* turnControls.interrupt(turn);

			// A message made a steer with the proof that its author may interrupt, not steer.
			// @ts-expect-error TS2345 [Argument of type 'CanInterrupt<NameA, NameD>' is not assignable to parameter of type 'CanSteer<NameA, NameD>']
			yield* turnControls.steer(canInterrupt, { messageId: "message", reason: "mention" });

			// Interrupting proved for one principal's member and another's reach of the chat.
			// @ts-expect-error TS2345 [Argument of type 'ReachesChat<NameA, NameC>' is not assignable to parameter of type 'ReachesChat<NameB, NameC>']
			yield* proveCanInterrupt(otherMember, reach, turn);

			yield* turnControls.steer(canSteer, { messageId: "message", reason: "mention" });
			yield* turnControls.interrupt(canInterrupt);
		}),
);

declare const turnComputers: TurnComputers.Interface;
declare const command: { command: string; timeout_seconds: number };

export const computerUseMistakes = named(
	principal,
	otherPrincipal,
	"chat",
	(principal, other, chat) =>
		named(
			{ kind: "request", request: "computer-example" } as const,
			{ host: "example.com" },
			(call, host) =>
				Effect.gen(function* () {
					const canUse = yield* proveCanUseChatComputer(principal, chat);
					const otherUses = yield* proveCanUseChatComputer(other, chat);
					const approved = yield* proveRealApproved(
						principal,
						call,
						approvalRule("computers.runCommand"),
						command,
						chat,
					);

					// @ts-expect-error TS2345 [Argument of type 'CanUseChatComputer<NameB, NameC>' is not assignable to parameter of type 'CanUseChatComputer<NoInfer<NameA>, NameC>'] Only the principal that can use the computer may request this host.
					yield* proveComputerRequestApproved(principal, call, host, otherUses);
					// @ts-expect-error TS2554 [Expected 4 arguments, but got 3.] Requesting a host requires authority to use the computer.
					yield* proveComputerRequestApproved(principal, call, host);
					yield* proveNamedApproval(
						principal,
						call,
						// @ts-expect-error TS2345 [parameter of type 'ApprovalRule<OrdinaryApproval, "computers.requestHost">] A computer request uses its dedicated approval prover.
						approvalRule("computers.requestHost"),
						host,
						chat,
					);

					// A command run on the computer another principal may use, with this one's approval.
					// @ts-expect-error TS2345 [Argument of type 'CanUseChatComputer<NameB, NameC>' is not assignable to parameter of type 'CanUseChatComputer<NameA, NameC>']
					yield* turnComputers.runCommand(otherUses, approved);

					// A command run with no proof that the call may run.
					// @ts-expect-error TS2740 [from type 'Approved<NameA, unknown, [NameC], "computers.runCommand">']
					yield* turnComputers.runCommand(canUse, canUse);

					// A host request read back with the reach of the chat, not the proof the bot may use its computer.
					const reach = yield* proveRealReachesChat(principal, chat);
					// @ts-expect-error TS2739 [from type 'CanUseChatComputer<NameA, NameC>'] Chat reach does not prove permission to read a computer request.
					yield* computerNetwork.requestedHost(reach, approved);

					yield* turnComputers.runCommand(canUse, approved);
					yield* computerNetwork.requestedHost(
						canUse,
						yield* proveComputerRequestApproved(principal, call, host, canUse),
					);
				}),
		),
);

export const automationFeedProofMistakes = named(
	principal,
	"workspace",
	"automation",
	"other automation",
	(principal, workspace, automation, otherAutomation) =>
		Effect.gen(function* () {
			const reach = yield* proveReachesAutomation(principal, workspace, automation);
			// @ts-expect-error TS2345 [Argument of type 'ReachesAutomation<NameA, NameC>' is not assignable to parameter of type 'ReachesAutomation<NameA, NameD>'] The reach proof targets a different automation feed.
			yield* chatsService.openAutomationFeed(otherAutomation, reach);
			yield* chatsService.openAutomationFeed(automation, reach);
		}),
);

declare const chatFilesService: ChatFiles.Interface;
declare const workspaceSetup: WorkspaceSetup.Interface;

export const chatFileReadProofMistakes = named(
	principal,
	otherPrincipal,
	"file",
	{ kind: "request", request: "chat-file-read-example" } as const,
	(principal, other, file, call) =>
		Effect.gen(function* () {
			const reach = yield* proveReachesFile(principal, file);
			const input = { file: file.value };
			const rule = approvalRule("chats.readChatFile");
			const approvedForOther = yield* proveRealApproved(other, call, rule, input, file);
			// @ts-expect-error TS2554 [Expected 2 arguments, but got 1.] Reading a chat file in a turn requires approval.
			yield* chatFilesService.readForTurn(reach);
			// @ts-expect-error TS2345 [Argument of type 'ReachesFile<NameA, NameC>' is not assignable to parameter of type 'ReachesFile<NameB, NameC>'] The approval belongs to another principal.
			yield* chatFilesService.readForTurn(reach, approvedForOther);
			yield* chatFilesService.readForTurn(
				reach,
				yield* proveRealApproved(principal, call, rule, input, file),
			);
		}),
);

export const chatAttachmentProofMistakes = named(
	principal,
	chatId,
	"file",
	"other file",
	(principal, chat, file, otherFile) =>
		Effect.gen(function* () {
			const reach = yield* proveReachesMessageFile(principal, chat, file);
			// @ts-expect-error TS2345 [Argument of type 'ReachesMessageFile<NameA, NameC>' is not assignable to parameter of type 'ReachesMessageFile<NameA, NameD>'] The named file must agree with the attachment reach proof.
			yield* chatFilesService.read(otherFile, reach);
			yield* chatFilesService.read(file, reach);

			const owns = yield* proveOwnsUnsentAttachment(yield* proveIsMember(principal), chat, file);
			// @ts-expect-error TS2741 [required in type 'OwnsUnsentAttachment<NameA, NameC>'] Reaching an attachment does not prove ownership of an unsent upload.
			yield* chatFilesService.removeUnsentAttachment(file, reach);
			// @ts-expect-error TS2345 [Argument of type 'OwnsUnsentAttachment<NameA, NameC>' is not assignable to parameter of type 'OwnsUnsentAttachment<NameA, NameD>'] The ownership proof targets another upload.
			yield* chatFilesService.removeUnsentAttachment(otherFile, owns);
			yield* chatFilesService.removeUnsentAttachment(file, owns);
		}),
);

export const computerProviderTargetMistakes = named(
	principal,
	"workspace",
	"provider",
	"other provider",
	(principal, workspace, provider, otherProvider) =>
		Effect.gen(function* () {
			const inWorkspace = yield* proveRealInWorkspace(principal, workspace);
			// @ts-expect-error TS2739 [from type 'CanManageWorkspace<unknown, unknown>'] Workspace membership does not authorize reaching provider settings.
			yield* proveReachesComputerProvider(inWorkspace, provider);
			const canManage = yield* proveCanManageWorkspace(inWorkspace);
			const target = yield* proveReachesComputerProvider(canManage, provider);
			// @ts-expect-error TS2345 [parameter of type 'ReachesComputerProvider<NameA, NameB, NameD>] The reach proof targets a different provider.
			yield* computerProviderSetup.test(canManage, otherProvider, target);
			yield* computerProviderSetup.test(canManage, provider, target);
		}),
);

export const workspaceSetupBotMistakes = named(
	principal,
	"workspace",
	"bot",
	"other bot",
	(principal, workspace, bot, otherBot) =>
		Effect.gen(function* () {
			const inWorkspace = yield* proveRealInWorkspace(principal, workspace);
			// @ts-expect-error TS2739 [from type 'CanManageWorkspace<unknown, unknown>'] Workspace membership does not authorize reaching the setup bot.
			yield* proveReachesSetupBot(inWorkspace, bot);
			const canManage = yield* proveCanManageWorkspace(inWorkspace);
			const target = yield* proveReachesSetupBot(canManage, bot);
			// @ts-expect-error TS2345 [Argument of type 'ReachesSetupBot<NameA, NameB, NameC>' is not assignable to parameter of type 'ReachesSetupBot<NameA, NameB, NameD>'] The reach proof targets a different setup bot.
			yield* workspaceSetup.complete(canManage, otherBot, target);
			yield* workspaceSetup.complete(canManage, bot, target);
		}),
);

export const invitationTargetMistakes = underWorkspaceLock(principal, "workspace", (lock) =>
	named("invitation", "other invitation", (invitation, otherInvitation) =>
		Effect.gen(function* () {
			const canCancel = yield* proveCanCancelInvitation(lock, invitation);
			// @ts-expect-error TS2345 [Argument of type 'CanCancelInvitation<P, W, NameA>' is not assignable to parameter of type 'CanCancelInvitation<P, W, NameB>'] The cancellation proof targets a different invitation.
			yield* membershipService.cancelInvitation(otherInvitation, canCancel);
			yield* membershipService.cancelInvitation(invitation, canCancel);
		}),
	),
);

declare const webService: Web.Interface;
declare const webBotPrincipal: BotForAsker;

export const webProofMistakes = named(
	webBotPrincipal,
	otherPrincipal,
	"workspace",
	{ kind: "request", request: "web-proof-example" } as const,
	(principal, other, workspace, call) =>
		Effect.gen(function* () {
			const input = { url: "https://example.com" };
			const canFetch = yield* proveCanUseWeb(principal, workspace, WEB_FETCH_TOOL);
			const canSearch = yield* proveCanUseWeb(principal, workspace, WEB_SEARCH_TOOL);
			const approved = yield* proveRealApproved(
				principal,
				call,
				approvalRule("web.fetch"),
				input,
				workspace,
			);
			const otherApproved = yield* proveRealApproved(
				other,
				call,
				approvalRule("web.fetch"),
				input,
				workspace,
			);

			// @ts-expect-error TS2554 [Expected 2 arguments, but got 1.] Fetching a page requires approval.
			yield* webService.fetch(canFetch);
			// @ts-expect-error TS2345 [Argument of type 'CanUseWeb<NameA, NameC, "web_search">' is not assignable to parameter of type 'CanUseWeb<NameA, NameC, "web_fetch">'] Search permission does not grant fetch permission.
			yield* webService.fetch(canSearch, approved);
			// @ts-expect-error TS2345 [Argument of type 'CanUseWeb<NameA, NameC, "web_fetch">' is not assignable to parameter of type 'CanUseWeb<NameB, NameC, "web_fetch">'] Approval from a different principal cannot authorize the fetch.
			yield* webService.fetch(canFetch, otherApproved);

			yield* webService.fetch(canFetch, approved);
		}),
);

declare const connectorCalls: ConnectorCalls.Interface;
declare const connectorTurn: RunsTurn<"principal", "turn">;
declare const connectorUse: CanUseConnector<"principal", "connector">;
declare const connectorApproval: RecordedApproval<
	"principal",
	"call",
	["turn", "connector"],
	"connectors.callTool"
>;
declare const anotherTurnApproval: RecordedApproval<
	"other principal",
	"other call",
	["turn", "connector"],
	"connectors.callTool"
>;

export const connectorCallMistakes = Effect.gen(function* () {
	// @ts-expect-error TS2554 [Expected 3 arguments, but got 2.] A connector call requires the approval recorded for that call.
	yield* connectorCalls.callTool(connectorTurn, connectorUse);
	// @ts-expect-error TS2345 [parameter of type 'Approved<"principal", "other call", ["turn", "connector"], "connect] The recorded approval belongs to a different turn principal.
	yield* connectorCalls.callTool(connectorTurn, connectorUse, anotherTurnApproval);
	yield* connectorCalls.callTool(connectorTurn, connectorUse, connectorApproval);
});

declare const approvalWithdrawals: Turns.ApprovalWithdrawals.Interface;
declare const routineWork: DoesStoredWork<"principal", "routine", "dueRoutine">;
declare const approvalExpiryWork: DoesStoredWork<"principal", "approval", "approvalExpiry">;

export const approvalWithdrawalMistakes = underWorkspaceLock(principal, "workspace", (lock) =>
	Effect.gen(function* () {
		// @ts-expect-error TS2740 [from type 'HoldsWorkspaceLock<unknown, unknown>'] Withdrawing approvals after reach changes requires the workspace lock.
		yield* approvalWithdrawals.afterReachChange(lock.workspace);
		// @ts-expect-error TS2345 [parameter of type 'DoesStoredWork<"principal", "routine", "approvalExpiry">] Approval expiry requires approval-expiry work.
		yield* approvalWithdrawals.expire(routineWork);
		yield* approvalWithdrawals.afterReachChange(lock);
		yield* approvalWithdrawals.expire(approvalExpiryWork);
	}),
);

declare const searchApproval: RecordedApproval<
	"principal",
	"call",
	["turn"],
	"connectors.searchTools"
>;
declare const otherSearchApproval: RecordedApproval<
	"other principal",
	"other call",
	["turn"],
	"connectors.searchTools"
>;

export const connectorSearchMistakes = Effect.gen(function* () {
	// @ts-expect-error TS2554 [Expected 2 arguments, but got 1.] Connector tool search requires approval.
	yield* connectorCalls.searchTools(connectorTurn);
	// @ts-expect-error TS2345 [parameter of type 'Approved<"principal", "other call", ["turn"], "connectors.searchToo] The recorded approval belongs to a different turn principal.
	yield* connectorCalls.searchTools(connectorTurn, otherSearchApproval);
	yield* connectorCalls.searchTools(connectorTurn, searchApproval);
});

export const computerAvailabilityMistake = Effect.gen(function* () {
	// @ts-expect-error TS2345 [Argument of type 'string' is not assignable to parameter of type 'CanUseChatComputer<unknown, unknown>'] A computer id does not prove permission to use the chat's computer.
	yield* turnComputers.requireComputer("computer-id");
});

declare const turnRecords: Turns.Records.Interface;
declare const turnStore: TurnStore.Interface;
declare const toolCallStore: ToolCallStore.Interface;
declare const stepTools: Turns.Tools.Interface;
declare const stepOperations: Parameters<Turns.Tools.Interface["forStep"]>[1];
declare const loadedStep: Parameters<Turns.Tools.Interface["forStep"]>[2];
declare const recorder: Turns.Tools.ToolCallRecorder;
declare const lostEnding: Parameters<Turns.Records.Interface["endLost"]>[1];

export const turnRecordMistakes = named(principal, "chat", "turn", (principal, chat, turn) =>
	Effect.gen(function* () {
		const running = yield* proveRunsTurn(yield* proveRealReachesChat(principal, chat), turn);
		const ending = yield* proveEndsTurn(principal, turn);

		// @ts-expect-error TS2739 [from type 'RunsTurn<NameA, NameC>'] Loading step data requires a running turn.
		yield* turnRecords.load(ending, 0);
		// @ts-expect-error TS2345 [Argument of type 'RunsTurn<NameA, NameC>' is not assignable to parameter of type 'EndsTurn<unknown, unknown>'] Ending lost work requires authority to end the turn.
		yield* turnRecords.endLost(running, lostEnding);
		// @ts-expect-error TS2739 [from type 'RunsTurn<NameA, NameC>'] Checking the current execution requires a running turn.
		yield* turnStore.current(ending);
		// @ts-expect-error TS2739 [from type 'RunsTurn<NameA, NameC>'] Claiming a tool call requires a running turn.
		yield* toolCallStore.claim(ending, "call");
		// @ts-expect-error TS2739 [from type 'RunsTurn<NameA, NameC>'] Offering tools for a step requires a running turn.
		yield* stepTools.forStep(ending, stepOperations, loadedStep, recorder);

		yield* turnRecords.load(running, 0);
		yield* turnRecords.endLost(ending, lostEnding);
		yield* turnStore.current(running);
		yield* toolCallStore.claim(running, "call");
		yield* stepTools.forStep(running, stepOperations, loadedStep, recorder);
	}),
);

declare const streams: Streams.Interface;
declare const details: ChatDetailsView.Interface;
declare const desktop: DesktopViewer.Interface;
declare const usage: Usage.Interface;
declare const timeZone: WorkspaceTimeZone.Interface;
declare const apps: GitHubApps.Interface;
declare const accounts: Accounts.Interface;
declare const filePages: FilePages.Interface;
declare const floor: FloorControl.Interface;
declare const month: Parameters<Usage.Interface["month"]>[1];
declare const committed: Parameters<FloorControl.Interface["giveFloor"]>[0];

export const reachServiceMistakes = named(
	principal,
	otherPrincipal,
	"chat",
	"bot",
	(principal, other, chat, bot) =>
		Effect.gen(function* () {
			const reachedChat = yield* proveRealReachesChat(principal, chat);
			const otherMember = yield* proveIsMember(other);
			const canTakePart = yield* proveRealCanTakePart(reachedChat);

			// @ts-expect-error TS2740 [from type 'ReachesChat<unknown, unknown>'] Listening to a chat requires proven reach to that chat.
			streams.hearingChat(chat);
			// @ts-expect-error TS2740 [from type 'IsMember<unknown>'] Listening to a member's stream requires a signed-in member.
			streams.hearingOwn(other);
			// @ts-expect-error TS2345 [Argument of type 'IsMember<NameB>' is not assignable to parameter of type 'IsMember<NameA>'] The member reporting typing must be the one taking part.
			yield* streams.reportTyping(canTakePart, otherMember);
			// @ts-expect-error TS2740 [from type 'ReachesChat<unknown, unknown>'] Reading chat details requires proven reach to the chat.
			yield* details.get(chat);
			// @ts-expect-error TS2740 [from type 'ReachesChat<unknown, unknown>'] Opening a bot's desktop requires proven reach to its chat.
			yield* desktop.openComputer(chat, bot);
			// @ts-expect-error TS2740 [from type 'IsMember<unknown>'] Reading a referral link requires a signed-in member.
			yield* accounts.referralLink(other);
			// @ts-expect-error TS2740 [from type 'IsMember<unknown>'] Resetting a referral link requires a signed-in member.
			yield* accounts.resetReferralLink(other);
			// @ts-expect-error TS2740 [from type 'ReachesChat<unknown, unknown>'] Giving up the floor requires proven reach to the chat.
			yield* floor.giveFloor(committed, chat);

			streams.hearingChat(reachedChat);
			streams.hearingOwn(otherMember);
			yield* streams.reportTyping(canTakePart, yield* proveIsMember(principal));
			yield* details.get(reachedChat);
			yield* desktop.openComputer(reachedChat, bot);
			yield* accounts.referralLink(otherMember);
			yield* accounts.resetReferralLink(otherMember);
			yield* floor.giveFloor(committed, reachedChat);
		}),
);

export const workspaceServiceMistakes = named(
	principal,
	"workspace",
	"project",
	"file",
	(principal, workspace, project, file) =>
		Effect.gen(function* () {
			const inWorkspace = yield* proveRealInWorkspace(principal, workspace);
			const canRead = yield* proveCanReadWorkspace(inWorkspace);
			const canManage = yield* proveCanManageWorkspace(inWorkspace);
			const reachedProject = yield* proveRealReachesProject(principal, project);

			// @ts-expect-error TS2739 [from type 'ReachSet<unknown, unknown>'] Listening to a workspace requires knowing which resources it offers this principal.
			yield* streams.hearingIn(inWorkspace);
			// @ts-expect-error TS2345 [Argument of type 'CanReadWorkspace<NameA, NameB>' is not assignable to parameter of type 'CanManageWorkspace<NameA, NameB>'] Reading usage requires workspace management permission.
			yield* usage.month(canRead, month);
			// @ts-expect-error TS2345 [Argument of type 'CanReadWorkspace<NameA, NameB>' is not assignable to parameter of type 'CanManageWorkspace<NameA, NameB>'] Reading the time zone setting requires workspace management permission.
			yield* timeZone.get(canRead);
			// @ts-expect-error TS2739 [from type 'CanManageProject<unknown, unknown>'] Starting a GitHub app requires project management permission.
			yield* apps.start(reachedProject, undefined);
			// @ts-expect-error TS2740 [from type 'ReachesFile<unknown, unknown>'] Making a page address requires proven reach to its file.
			yield* filePages.address(file, 1);

			yield* streams.hearingIn(proveReachSet(inWorkspace));
			yield* usage.month(canManage, month);
			yield* timeZone.get(canManage);
			yield* apps.start(yield* proveRealCanManageProject(reachedProject), undefined);
			yield* filePages.address(yield* proveReachesFile(principal, file), 1);
		}),
);

declare const runner: AutomationRunner.Interface;
declare const automationStore: AutomationStore.Interface;
declare const projectComputers: ProjectComputers.Interface;
declare const uninstalls: GitHubUninstalls.Interface;
declare const pauseWork: DoesStoredWork<"principal", "automation", "pauseAfterFailures">;
declare const sleepWork: DoesStoredWork<"principal", "computer", "computerSleep">;
declare const uninstallWork: DoesStoredWork<"principal", "uninstall", "gitHubUninstall">;

export const storedWorkMistakes = Effect.gen(function* () {
	// @ts-expect-error TS2345 [parameter of type 'DoesStoredWork<"principal", "automation", "dueRoutine">] Pause work cannot authorize running a due routine.
	yield* runner.runDueRoutine(pauseWork);
	// @ts-expect-error TS2345 [parameter of type 'DoesStoredWork<"principal", "routine", "pauseAfterFailures">] Due-routine work cannot authorize pausing an automation.
	yield* automationStore.pauseAfterFailures(routineWork);
	// @ts-expect-error TS2345 [parameter of type 'DoesStoredWork<"principal", "routine", "computerSleep">] Due-routine work cannot authorize sleeping a computer.
	yield* projectComputers.sleepIfIdle(routineWork);
	// @ts-expect-error TS2345 [parameter of type 'DoesStoredWork<"principal", "routine", "gitHubUninstall">] Due-routine work cannot authorize uninstalling a GitHub app.
	yield* uninstalls.uninstall(routineWork);

	yield* runner.runDueRoutine(routineWork);
	yield* automationStore.pauseAfterFailures(pauseWork);
	yield* projectComputers.sleepIfIdle(sleepWork);
	yield* uninstalls.uninstall(uninstallWork);
});

export const pageServingMistakes = named(page, "file", (principal, file) =>
	Effect.gen(function* () {
		const reach = yield* proveReachesFile(principal, file);
		// @ts-expect-error TS2741 [required in type 'ReachesPage<unknown, unknown>'] File reach does not authorize serving a page version.
		yield* filesService.servePage(reach);
		yield* filesService.servePage(yield* proveReachesPage(principal, file));
	}),
);

declare const connectorEvents: Automations.ConnectorEventsInterface;
declare const activity: Parameters<Automations.ConnectorEventsInterface["accept"]>[1];

export const connectorEventMistakes = named(principal, "connector", (principal, connector) =>
	Effect.gen(function* () {
		// @ts-expect-error TS2740 [from type 'SignedByGitHubApp<unknown, unknown>'] A named connector does not prove which GitHub app signed the delivery.
		yield* connectorEvents.accept(connector, activity);
		yield* connectorEvents.accept(yield* proveSignedByGitHubApp(principal, connector), activity);
	}),
);

export const computerDeletionMistakes = named("workspace", "project", (workspace, project) =>
	Effect.gen(function* () {
		const workspaceDeletion = yield* proveDeletionRecorded(workspace);
		const projectDeletion = yield* proveProjectDeletionRecorded(workspace, project);
		if (!workspaceDeletion || !projectDeletion) return;
		// @ts-expect-error TS2741 [required in type 'ProjectDeletionRecorded<NameA, unknown>'] Destroying one project's computer requires a recorded project deletion.
		yield* projectComputers.destroy(workspaceDeletion);
		// @ts-expect-error TS2345 [Argument of type 'ProjectDeletionRecorded<NameA, NameB>' is not assignable to parameter of type 'DeletionRecorded<unknown>'] Destroying all computers requires a recorded workspace deletion.
		yield* projectComputers.destroyAllIn(projectDeletion);
		yield* projectComputers.destroy(projectDeletion);
		yield* projectComputers.destroyAllIn(workspaceDeletion);
	}),
);

export const approvalInputMistake = named(principal, projectCall, "bot", (principal, call, bot) =>
	Effect.gen(function* () {
		const input = { botId: "bot" };
		// @ts-expect-error TS2739 [from type 'Named<unknown, { readonly botId: string; }>'] The approval input must be named so the proof is bound to it.
		yield* proveNamedApproval(principal, call, approvalRule("bots.pin"), input, bot);
		yield* named(input, (input) =>
			proveNamedApproval(principal, call, approvalRule("bots.pin"), input, bot),
		);
	}),
);

export const workspaceOpeningMistakes = Effect.gen(function* () {
	// @ts-expect-error TS2345 [Argument of type 'CanReadWorkspace<P, W>' is not assignable to parameter of type 'CanManageWorkspace<P, W>'] Opening a workspace to read it does not let a body manage it.
	yield* readingWorkspace(principal, "acme", (canRead) => usage.month(canRead, month));
	yield* managingWorkspace(principal, "acme", (canManage) => usage.month(canManage, month));
});

/** An opening for a body that manages the workspace, which proves only that its principal reads it. */
export const managingWorkspaceProvingRead = <Success, Failure, Services>(
	principal: Principal,
	workspaceId: string,
	body: <P, W>(canManage: CanManageWorkspace<P, W>) => Effect.Effect<Success, Failure, Services>,
) =>
	named(principal, workspaceId, (principal, workspace) =>
		Effect.flatMap(
			Effect.flatMap(proveRealInWorkspace(principal, workspace), proveCanReadWorkspace),
			// @ts-expect-error TS2345 [is not assignable to parameter of type '(a: CanReadWorkspace<NameA, NameB>)] Proving the workspace is read hands a body that manages it the wrong proof.
			body,
		),
	);

export const managingWorkspaceProvingManagement = <Success, Failure, Services>(
	principal: Principal,
	workspaceId: string,
	body: <P, W>(canManage: CanManageWorkspace<P, W>) => Effect.Effect<Success, Failure, Services>,
) =>
	named(principal, workspaceId, (principal, workspace) =>
		Effect.flatMap(
			Effect.flatMap(proveRealInWorkspace(principal, workspace), proveCanManageWorkspace),
			body,
		),
	);
