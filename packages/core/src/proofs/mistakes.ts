/**
 * Near-misses with proofs, principals and tiers, one per line under
 * `@ts-expect-error`. Type-checked and never run or imported: if a change makes
 * one of these lines compile, the unused `@ts-expect-error` fails the
 * typecheck. Add a line for every near-miss found in review.
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
import { OperationContract } from "@sugabots/contracts/operations";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "@sugabots/contracts/operations/web";
import { Context, Effect, Layer, Schema } from "effect";
import type { WorkspaceGuide } from "../chats/assistant/workspace-guide.ts";
import type { ProjectAutomations } from "../chats/automations/project-automations.ts";
import type { ChatFiles } from "../chats/chats/chat-files.ts";
import type { ChatView } from "../chats/chats/chat-view.ts";
import type { Chats } from "../chats/chats/chats.ts";
import type { Reactions } from "../chats/reactions/reactions.ts";
import type { TurnComputers } from "../chats/tools/computer/turn-computers.ts";
import type { Turns } from "../chats/turns/turns.ts";
import type { ComputerNetwork } from "../computers/computer-network.ts";
import type { ComputerProviderSetup } from "../computers/computer-provider-setup.ts";
import type { ProjectComputerSetup } from "../computers/project-computer-setup.ts";
import { Transaction } from "../database/database.ts";
import type { Files } from "../files/files.ts";
import type { Notifications } from "../notifications/notifications.ts";
import { defineOperation } from "../operations/operation.ts";
import type {
	BotForAsker,
	MemberSession,
	PageAddress,
	Principal,
	SystemWork,
} from "../principal.ts";
import type { ConnectorCalls } from "../providers/connectors/connector-calls.ts";
import type { Connectors } from "../providers/connectors/connectors.ts";
import type { GitHubConnectors } from "../providers/connectors/github/github-connectors.ts";
import type { ModelProviders } from "../providers/model-providers/model-providers.ts";
import type { SearchProviders } from "../providers/search-providers/search-providers.ts";
import type { Web } from "../providers/web/web.ts";
import { processLayer, Tier } from "../tiers.ts";
import type { Bots } from "../workspaces/bots/bots.ts";
import type { Membership } from "../workspaces/membership/membership.ts";
import type { Projects } from "../workspaces/projects/projects.ts";
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
import { proveWorkspaceDeletionStarted } from "./deletion-started.ts";
import type { DoesStoredWork } from "./does-stored-work.ts";
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
	type CanChangeChat as RealCanChangeChat,
	type CanManageProject as RealCanManageProject,
} from "./project-permissions.ts";
import { defineProof, type Named, named, type Proof } from "./proof.ts";
import { proveReachSet } from "./reach-set.ts";
import { proveReachesAutomation } from "./reaches-automation.ts";
import { proveReachesAutomationTrigger } from "./reaches-automation-trigger.ts";
import { proveReachesBot } from "./reaches-bot.ts";
import {
	proveReachesChat as proveRealReachesChat,
	type ReachesChat as RealReachesChat,
} from "./reaches-chat.ts";
import { proveReachesComputerProvider } from "./reaches-computer-provider.ts";
import { proveReachesConnector } from "./reaches-connector.ts";
import {
	proveOwnsUnsentAttachment,
	proveReachesFile,
	proveReachesMessageFile,
} from "./reaches-file.ts";
import { proveReachesMessage } from "./reaches-message.ts";
import {
	proveReachesProject as proveRealReachesProject,
	type ReachesProject as RealReachesProject,
} from "./reaches-project.ts";
import {
	proveReachesProjectAutomation,
	proveRestrictableAutomation,
} from "./reaches-project-automation.ts";
import { proveReachesSetupBot } from "./reaches-setup-bot.ts";
import type { RunsTurn } from "./runs-turn.ts";
import { proveSignedByGitHubApp } from "./signed-by-github-app.ts";
import { proveCanInterrupt, proveCanSteer } from "./turn-control.ts";
import { underWorkspaceLock } from "./workspace-lock.ts";
import { proveCanManageWorkspace, proveCanReadWorkspace } from "./workspace-permissions.ts";

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
	// @ts-expect-error
	const swapped: ReachesChat<C, P> = ReachesChatProof.prove([principal, chat], { chat });
	// @ts-expect-error
	const otherKind: CanTakePart<P, C> = ReachesChatProof.prove([principal, chat], { reach: proof });
	return [proof, swapped, otherKind];
};

export const mistakes = named(principal, chatId, otherChatId, (principal, chatA, chatB) =>
	Effect.gen(function* () {
		const reachA = yield* proveReachesChat(principal, chatA);
		const reachB = yield* proveReachesChat(principal, chatB);
		const canTakePartA = proveCanTakePart(reachA);

		// A raw chat id handed to a service that wants a named one.
		// @ts-expect-error
		yield* chats.rename(chatId, canTakePartA);

		// A proof about chat A used for chat B.
		// @ts-expect-error
		yield* chats.setResolved(reachB, true, canTakePartA);

		// `CanTakePart` where `CanChangeChat` is needed.
		// @ts-expect-error
		yield* chats.rename(chatA, canTakePartA);

		// A spread copy of a named value, with another value.
		// @ts-expect-error
		yield* chats.post({ ...chatA, value: otherChatId }, canTakePartA);

		yield* chats.post(chatA, canTakePartA);

		yield* chats.setResolved(reachA, true, canTakePartA);
	}),
);

export const membershipMistakes = named(principal, "workspace", (principal, workspace) =>
	Effect.gen(function* () {
		const membership = yield* proveInWorkspace(principal, workspace);

		// A spread copy of `InWorkspace` with another role.
		// @ts-expect-error
		yield* memberships.promote({ ...membership, role: "owner" });

		yield* memberships.promote(membership);
	}),
);

// A named value returned out of `named`.
// @ts-expect-error
export const escaped = named(chatId, (chat) => Effect.succeed(chat));

export const projectMistakes = named(
	principal,
	"project",
	"other project",
	(principal, project, otherProject) =>
		Effect.gen(function* () {
			const reach = yield* proveReachesProject(principal, project);
			const otherReach = yield* proveReachesProject(principal, otherProject);

			// A `ReachesProject` for project J paired with a permission for J′.
			// @ts-expect-error
			yield* projects.archive(reach, proveCanManageProject(otherReach));

			yield* projects.archive(reach, proveCanManageProject(reach));
		}),
);

export const approvalMistakes = named(
	principal,
	"tool call",
	"other tool call",
	(principal, call, otherCall) =>
		Effect.gen(function* () {
			const approved = yield* proveApproved(principal, call);

			// `Approved<P, X1>` used for X2.
			// @ts-expect-error
			yield* toolCalls.run(otherCall, approved);

			yield* toolCalls.run(call, approved);
		}),
);

declare const memberOnly: (principal: MemberSession) => Effect.Effect<void>;
declare const botForAsker: BotForAsker;

// A `MemberSession`-only operation called with a `BotForAsker`.
// @ts-expect-error
export const botAsMember = memberOnly(botForAsker);

// Building a `Principal` literal.
// @ts-expect-error
export const forged: MemberSession = { _tag: "MemberSession", member: "someone" };

declare const session: MemberSession;
// A spread copy of a principal, with another member.
// @ts-expect-error
export const copied: MemberSession = { ...session, member: "someone else" };

// A spread copy of a bot's principal, with wider bounds.
// @ts-expect-error
export const widened: BotForAsker = { ...botForAsker, bounds: { kind: "member" } };

// Building system work naming another chat.
// @ts-expect-error
export const forgedWork: SystemWork = {
	_tag: "SystemWork",
	workspace: "workspace",
	work: { kind: "compaction", chat: "someone else's chat" },
};

declare const page: PageAddress;
// A spread copy of a page address, opening another page.
// @ts-expect-error
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
	// @ts-expect-error
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
	// @ts-expect-error
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
	// @ts-expect-error
	Layer.succeedContext(Context.make(CurrentRequest, { id: "one request's" })),
);

// The database's open transaction is request tier too, however it is imported.
export const providesTransaction = processLayer(
	// @ts-expect-error
	Layer.succeedContext(
		Context.make(Transaction, { beforeCommit: [], batches: new Map(), afterCommit: [] }),
	),
);

// An outer `Layer.unwrap` that reads a request-tier service while choosing a layer
// that is fine itself.
export const choosesWhileReadingRequest = processLayer(
	// @ts-expect-error
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
	// @ts-expect-error
	Layer.fromBuild(() =>
		Effect.map(CurrentRequest, (request) =>
			Context.make(Lookup, { describe: Effect.log(request.id) }),
		),
	),
);

export const discardsAfterRequest = processLayer(
	// @ts-expect-error
	Layer.effectDiscard(Effect.flatMap(CurrentRequest, (request) => Effect.log(request.id))),
);

const setResolved = OperationContract.make("chats.setResolved", {
	description: "Mark this chat resolved, or reopen it.",
	input: Schema.Struct({ chatId: Schema.String, resolved: Schema.Boolean }),
	output: Schema.Void,
	errors: [],
	changes: true,
});

// An operation's body failing with an error its contract doesn't list.
// @ts-expect-error
export const undeclaredError = defineOperation(setResolved, () => Effect.fail("refused"));

// An operation's body reading an input field its contract doesn't have.
// @ts-expect-error
export const unknownInput = defineOperation(setResolved, (_, input) => Effect.log(input.chatName));

export const declared = defineOperation(setResolved, (_, input) => Effect.log(input.chatId));

export const assumesToolCall = defineOperation(setResolved, (_, __, call) =>
	// An operation's body reading a tool call's id from a call that may be an HTTP request.
	// @ts-expect-error
	Effect.log(call.toolCall),
);

// The real provers, misused the same ways.

declare const realProjects: {
	readonly rename: <P, J>(
		reach: RealReachesProject<P, J>,
		access: RealCanManageProject<P, J>,
	) => Effect.Effect<void>;
};
declare const realChats: {
	readonly setResolved: <P, C>(
		reach: RealReachesChat<P, C>,
		access: RealCanChangeChat<P, C>,
	) => Effect.Effect<void>;
};

export const realProjectMistakes = named(
	principal,
	"project",
	"other project",
	(principal, project, otherProject) =>
		Effect.gen(function* () {
			const reach = yield* proveRealReachesProject(principal, project);
			const managesOther = yield* proveRealCanManageProject(
				yield* proveRealReachesProject(principal, otherProject),
			);

			// `CanManageProject` proven for J′, handed over with the reach of J.
			// @ts-expect-error
			yield* realProjects.rename(reach, managesOther);

			yield* realProjects.rename(reach, yield* proveRealCanManageProject(reach));
		}),
);

export const realChatMistakes = named(
	principal,
	chatId,
	otherChatId,
	(principal, chat, otherChat) =>
		Effect.gen(function* () {
			const reach = yield* proveRealReachesChat(principal, chat);
			const changesOther = yield* proveRealCanChangeChat(
				yield* proveRealReachesChat(principal, otherChat),
			);

			// `CanChangeChat` proven for another chat.
			// @ts-expect-error
			yield* realChats.setResolved(reach, changesOther);

			yield* realChats.setResolved(reach, yield* proveRealCanChangeChat(reach));
		}),
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
				const approved = yield* proveRealApproved(lock.principal, call, addBotApproval, input);
				const approvedForOther = yield* proveRealApproved(other, call, addBotApproval, input);

				// A project's members changed with a reach proved for a principal named outside the lock.
				// @ts-expect-error
				yield* proveCanChangeProjectMembers(lock, yield* proveRealReachesProject(other, project));

				// A bot proven reached by another principal, added to a project this one may change.
				// @ts-expect-error
				yield* projectsService.addBot(canChange, yield* proveReachesBot(other, bot), approved);

				// A bot added for a bot's call another principal's approval allowed.
				const reachesBot = yield* proveReachesBot(lock.principal, bot);
				// @ts-expect-error
				yield* projectsService.addBot(canChange, reachesBot, approvedForOther);

				// A project deleted with the proof that its members may be changed, not that it may be deleted.
				// @ts-expect-error
				yield* projectsService.remove(canChange);

				// A project's members listed with no proof that it is reached, only its id.
				// @ts-expect-error
				yield* projectsService.members(project);

				// A member added by a write taken out of the transaction that holds the lock.
				// @ts-expect-error
				const outsideTheLock: Effect.Effect<void, NotInWorkspace> = projectsService.addMember(
					canChange,
					member,
				);

				yield* outsideTheLock;
				yield* projectsService.addMember(canChange, member);
				yield* projectsService.addBot(
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
			// @ts-expect-error
			yield* computerProviderSetup.list(canRead);

			// A project's allowed hosts changed by its managers outside member bounds, with `CanManageProject`.
			// @ts-expect-error
			yield* computerNetwork.addProjectHost(canManage, "example.com");

			// A project's computer reset by whoever reaches the project, not whoever manages it.
			// @ts-expect-error
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

export const providersServiceMistakes = named(principal, "workspace", (principal, workspace) =>
	Effect.gen(function* () {
		const inWorkspace = yield* proveRealInWorkspace(principal, workspace);
		const canRead = yield* proveCanReadWorkspace(inWorkspace);
		const canManage = yield* proveCanManageWorkspace(inWorkspace);
		const reach = proveReachSet(inWorkspace);

		// @ts-expect-error The workspace guide needs the approval proof for the call.
		yield* guides.guide(canRead, reach);

		// A provider's key changed with the proof that the workspace may be read, not that its providers may be managed.
		// @ts-expect-error
		yield* modelProvidersService.update(canRead, "provider", { apiKey: "key" });

		// A search provider removed with no proof, only the workspace's id.
		// @ts-expect-error
		yield* searchProvidersService.remove(workspace);

		yield* modelProvidersService.update(canManage, "provider", { apiKey: "key" });
		yield* modelProvidersService.listEnabledModels(canRead);
		yield* searchProvidersService.remove(canManage);
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
				const approved = yield* proveRealApproved(principal, call, approvalRule("bots.pin"), {
					botId: bot.value,
				});

				// A bot deleted with the proof that it may be managed, not that it may be deleted.
				// @ts-expect-error
				yield* botsService.beginRemoval(canManage);

				// A bot deleted with the proof that it may be restricted, not that it may be deleted.
				// @ts-expect-error
				yield* botsService.beginRemoval(canRestrict);

				// A bot changed with the proof that an admin may restrict it, which changes nothing of it.
				// @ts-expect-error
				yield* botsService.update(canRestrict, {});

				// A bot pinned for one principal with another's proof that it reaches it.
				// @ts-expect-error
				yield* botsService.setPinned(otherActsForMember, reach, true, approved);

				// A bot pinned with no proof the call was approved.
				// @ts-expect-error
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
			// @ts-expect-error
			yield* proveCanDeleteBot(lock, managedOutside);

			// A bot made personal with no proof made under its workspace's lock.
			// @ts-expect-error
			yield* botsService.update(canManage, { visibility: "personal" }, canManage);

			yield* botsService.beginRemoval(yield* proveCanDeleteBot(lock, canManage));
			yield* botsService.beginRemoval(yield* proveCanDeleteBot(lock, canRestrict));
			yield* botsService.update(
				canManage,
				{ visibility: "personal" },
				yield* proveCanChangeBotReach(lock, canManage),
			);
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

			// @ts-expect-error
			yield* automationsService.create(reach, member, settings);

			// @ts-expect-error
			yield* automationsService.createWithRoutine(canManage, member, settings, routine);

			// @ts-expect-error
			yield* automationsService.updateInChat(canManage, automation, target, member, {}, routine);

			yield* automationsService.create(canManage, member, settings);

			// An automation run with the proof that its project may be managed, not that a run may be started there.
			// @ts-expect-error
			yield* automationsService.run(canManage, automation, target, "request");

			// An automation changed at will by an admin who may only switch it off.
			// @ts-expect-error
			yield* automationsService.update(canRestrict, automation, target, member, { name: "Mine" });

			// @ts-expect-error
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
					// @ts-expect-error
					yield* automationsService.removeTrigger(canManage, otherTrigger, reached.target);
					yield* automationsService.removeTrigger(canManage, trigger, reached.target);

					// @ts-expect-error
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
			// @ts-expect-error
			yield* membershipService.delete(canRead);

			// A member taken out by a write taken out of the transaction that holds the lock.
			// @ts-expect-error
			const outsideTheLock: Effect.Effect<{ cleanupPending: boolean }, SubscriptionInUse> =
				membershipService.beginRemoval(canRemove);

			// A membership changed by a principal proved in the workspace outside the lock, with no lock of its own.
			// @ts-expect-error
			yield* proveCanChangeMembership(otherInWorkspace, member, { kind: "removal" });

			// A member's own workspaces listed with only the principal, not the proof a member is signed in.
			// @ts-expect-error
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
			// @ts-expect-error
			yield* notificationsService.setLevel(isMember, reachedByOther, "all");

			// A member's settings read with only the principal, not the proof a member is signed in.
			// @ts-expect-error
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
			// @ts-expect-error
			yield* proveCanDeleteWorkspace(yield* proveRealInWorkspace(other, lock.workspace));

			yield* membershipService.beginDeletion(canDelete);
			const started = yield* proveWorkspaceDeletionStarted(lock);
			if (!started) return;

			// A recorded deletion still needs its workspace's lock to finish.
			// @ts-expect-error
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
			// @ts-expect-error
			yield* connectorsService.remove(canRead, connector, target);

			// A project's connectors listed with no proof that they may be read, only that it is reached.
			// @ts-expect-error
			yield* connectorsService.list(reach);

			// A delivery read with the proof that its project is reached, not that its GitHub app signed it.
			// @ts-expect-error
			yield* gitHubConnectorsService.readDelivery(reach, delivery);

			// @ts-expect-error
			yield* connectorsService.remove(canManage, otherConnector, target);
			// @ts-expect-error
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
	approvalRule,
	proveComputerRequestApproved,
	proveApproved as proveRealApproved,
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
				const approved = yield* proveRealApproved(principal, call, resolveApproval, {
					chatId: chat.value,
					resolved: true,
				});
				const canChange = yield* proveRealCanChangeChat(reach);
				const newFile = { kind: "markdown", title: "Notes", content: "# Notes" } as const;
				// @ts-expect-error
				yield* filesService.create(canChange, newFile);
				// @ts-expect-error
				yield* filesService.create(canTakePart, approved, newFile);
				// @ts-expect-error
				yield* filesService.listWritten(reach);
				// @ts-expect-error
				yield* chatsService.setResolved(reach, true, canChange);

				// `CanChangeChat` proven for another chat, handed over with the reach of this one.
				// @ts-expect-error
				yield* chatsService.setResolved(reach, true, changesOther, approved);

				// A message posted as another principal's member, in a chat this one takes part in.
				// @ts-expect-error
				yield* chatsService.post(yield* proveIsMember(other), canTakePart, posted);

				// A chat renamed with the proof that it may be changed, not that its project's chats may be managed.
				// @ts-expect-error
				yield* chatsService.renameChat(reach, "Renamed", yield* proveRealCanChangeChat(reach));

				// A page of a chat read with the reach of its project, not of the chat.
				// @ts-expect-error
				yield* chatViewService.messages(yield* proveRealReachesProject(principal, chat), firstPage);

				yield* chatsService.setResolved(reach, true, canChange, approved);
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

			// @ts-expect-error
			yield* filesService.readWritten(reach);

			// A file deleted with the proof that another file's chats may be managed.
			// @ts-expect-error
			yield* filesService.remove(reach, managesOther);

			// A reaction added with the reach of a chat, not of the message.
			// @ts-expect-error
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
		// @ts-expect-error
		yield* turnControls.decide(otherMember, canDecide, "deny", changesNothing);

		// A call decided with no proof that the member is its approver, only its id.
		// @ts-expect-error
		yield* turnControls.decide(isMember, call, "deny", changesNothing);

		// A host request granted as another member than the approver `CanDecide` found.
		// @ts-expect-error
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
			// @ts-expect-error
			yield* turnControls.interrupt(canSteer);

			// A turn interrupted with no proof at all, only its id.
			// @ts-expect-error
			yield* turnControls.interrupt(turn);

			// A message made a steer with the proof that its author may interrupt, not steer.
			// @ts-expect-error
			yield* turnControls.steer(canInterrupt, { messageId: "message", reason: "mention" });

			// Interrupting proved for one principal's member and another's reach of the chat.
			// @ts-expect-error
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
		named({ kind: "request", request: "computer-example" } as const, (call) =>
			Effect.gen(function* () {
				const canUse = yield* proveCanUseChatComputer(principal, chat);
				const otherUses = yield* proveCanUseChatComputer(other, chat);
				const approved = yield* proveRealApproved(
					principal,
					call,
					approvalRule("computers.runCommand"),
					command,
				);

				const host = { host: "example.com" };
				// @ts-expect-error
				yield* proveComputerRequestApproved(principal, call, host, otherUses);
				// @ts-expect-error
				yield* proveComputerRequestApproved(principal, call, host);
				// @ts-expect-error
				yield* proveRealApproved(principal, call, approvalRule("computers.requestHost"), host);

				// A command run on the computer another principal may use, with this one's approval.
				// @ts-expect-error
				yield* turnComputers.runCommand(otherUses, approved, command);

				// A command run with no proof that the call may run.
				// @ts-expect-error
				yield* turnComputers.runCommand(canUse, canUse, command);

				// A host request read back with the reach of the chat, not the proof the bot may use its computer.
				const reach = yield* proveRealReachesChat(principal, chat);
				// @ts-expect-error
				yield* computerNetwork.requestedHost(reach, approved, "example.com");

				yield* turnComputers.runCommand(canUse, approved, command);
				yield* computerNetwork.requestedHost(canUse, approved, "example.com");
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
			// @ts-expect-error
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
			const approvedForOther = yield* proveRealApproved(other, call, rule, input);
			// @ts-expect-error
			yield* chatFilesService.readForTurn(reach, {});
			// @ts-expect-error
			yield* chatFilesService.readForTurn(reach, {}, approvedForOther);
			yield* chatFilesService.readForTurn(
				reach,
				{},
				yield* proveRealApproved(principal, call, rule, input),
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
			// @ts-expect-error
			yield* chatFilesService.read(otherFile, reach);
			yield* chatFilesService.read(file, reach);

			const owns = yield* proveOwnsUnsentAttachment(yield* proveIsMember(principal), chat, file);
			// @ts-expect-error
			yield* chatFilesService.removeUnsentAttachment(file, reach);
			// @ts-expect-error
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
			// @ts-expect-error
			yield* proveReachesComputerProvider(inWorkspace, provider);
			const canManage = yield* proveCanManageWorkspace(inWorkspace);
			const target = yield* proveReachesComputerProvider(canManage, provider);
			// @ts-expect-error
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
			// @ts-expect-error
			yield* proveReachesSetupBot(inWorkspace, bot);
			const canManage = yield* proveCanManageWorkspace(inWorkspace);
			const target = yield* proveReachesSetupBot(canManage, bot);
			// @ts-expect-error
			yield* workspaceSetup.complete(canManage, otherBot, target);
			yield* workspaceSetup.complete(canManage, bot, target);
		}),
);

export const invitationTargetMistakes = underWorkspaceLock(principal, "workspace", (lock) =>
	named("invitation", "other invitation", (invitation, otherInvitation) =>
		Effect.gen(function* () {
			const canCancel = yield* proveCanCancelInvitation(lock, invitation);
			// @ts-expect-error
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
			const approved = yield* proveRealApproved(principal, call, approvalRule("web.fetch"), input);
			const otherApproved = yield* proveRealApproved(other, call, approvalRule("web.fetch"), input);

			// @ts-expect-error
			yield* webService.fetch(canFetch, input);
			// @ts-expect-error
			yield* webService.fetch(canSearch, input, approved);
			// @ts-expect-error
			yield* webService.fetch(canFetch, input, otherApproved);

			yield* webService.fetch(canFetch, input, approved);
		}),
);

declare const connectorCalls: ConnectorCalls.Interface;
declare const connectorTurn: RunsTurn<"principal", "turn">;
declare const connectorUse: CanUseConnector<"principal", "connector">;
declare const connectorApproval: RecordedApproval<"principal", "call">;
declare const anotherTurnApproval: RecordedApproval<"other principal", "other call">;

export const connectorCallMistakes = Effect.gen(function* () {
	// @ts-expect-error
	yield* connectorCalls.callTool(connectorTurn, connectorUse);
	// @ts-expect-error
	yield* connectorCalls.callTool(connectorTurn, connectorUse, anotherTurnApproval);
	yield* connectorCalls.callTool(connectorTurn, connectorUse, connectorApproval);
});

declare const approvalWithdrawals: Turns.ApprovalWithdrawals.Interface;
declare const routineWork: DoesStoredWork<"principal", "routine", "dueRoutine">;
declare const approvalExpiryWork: DoesStoredWork<"principal", "approval", "approvalExpiry">;

export const approvalWithdrawalMistakes = underWorkspaceLock(principal, "workspace", (lock) =>
	Effect.gen(function* () {
		// @ts-expect-error
		yield* approvalWithdrawals.afterReachChange(lock.workspace);
		// @ts-expect-error
		yield* approvalWithdrawals.expire(routineWork);
		yield* approvalWithdrawals.afterReachChange(lock);
		yield* approvalWithdrawals.expire(approvalExpiryWork);
	}),
);

export const connectorSearchMistakes = Effect.gen(function* () {
	// @ts-expect-error
	yield* connectorCalls.searchTools(connectorTurn, "issues");
	// @ts-expect-error
	yield* connectorCalls.searchTools(connectorTurn, anotherTurnApproval, "issues");
	yield* connectorCalls.searchTools(connectorTurn, connectorApproval, "issues");
});

export const computerAvailabilityMistake = Effect.gen(function* () {
	// @ts-expect-error
	yield* turnComputers.requireComputer("computer-id");
});
