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

import type { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { OperationContract } from "@sugabots/contracts/operations";
import { Context, Effect, Layer, Schema } from "effect";
import type { ProjectAutomations } from "../chats/automations/project-automations.ts";
import type { ChatView } from "../chats/chats/chat-view.ts";
import type { Chats } from "../chats/chats/chats.ts";
import type { Reactions } from "../chats/reactions/reactions.ts";
import type { Turns } from "../chats/turns/turns.ts";
import type { ComputerNetwork } from "../computers/computer-network.ts";
import type { ComputerProviderSetup } from "../computers/computer-provider-setup.ts";
import type { ProjectComputerSetup } from "../computers/project-computer-setup.ts";
import type { Database } from "../database/database.ts";
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
import type { Connectors } from "../providers/connectors/connectors.ts";
import type { GitHubConnectors } from "../providers/connectors/github/github-connectors.ts";
import type { ModelProviders } from "../providers/model-providers/model-providers.ts";
import type { SearchProviders } from "../providers/search-providers/search-providers.ts";
import { processLayer, Tier } from "../tiers.ts";
import type { Bots } from "../workspaces/bots/bots.ts";
import type { Membership } from "../workspaces/membership/membership.ts";
import type { Projects } from "../workspaces/projects/projects.ts";
import { proveCanDeleteBot } from "./bot-permissions.ts";
import { proveCallsWebhook } from "./calls-webhook.ts";
import { proveCanDecide } from "./can-decide.ts";
import { proveCanManageBot } from "./can-manage-bot.ts";
import { proveCanRestrictBot, proveCanRestrictBotsProject } from "./can-restrict-bot.ts";
import { proveCanManageChats } from "./chat-permissions.ts";
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
import { proveReachesBot } from "./reaches-bot.ts";
import {
	proveReachesChat as proveRealReachesChat,
	type ReachesChat as RealReachesChat,
} from "./reaches-chat.ts";
import { proveReachesFile } from "./reaches-file.ts";
import { proveReachesMessage } from "./reaches-message.ts";
import {
	proveReachesProject as proveRealReachesProject,
	type ReachesProject as RealReachesProject,
} from "./reaches-project.ts";
import { proveSignedByGitHubApp } from "./signed-by-github-app.ts";
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

export const processOnly = processLayer(
	Layer.effect(
		Lookup,
		Effect.gen(function* () {
			const registry = yield* Registry;
			return { describe: Effect.log(registry.size) };
		}),
	),
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
declare const otherPrincipal: Principal;

export const projectsServiceMistakes = named(
	principal,
	otherPrincipal,
	"project",
	"bot",
	(principal, other, project, bot) =>
		Effect.gen(function* () {
			const reach = yield* proveRealReachesProject(principal, project);
			const canChange = yield* proveCanChangeProjectMembers(reach);

			// A bot proven reached by another principal, added to a project this one may change.
			// @ts-expect-error
			yield* projectsService.addBot(canChange, yield* proveReachesBot(other, bot));

			// A project deleted with the proof that its members may be changed, not that it may be deleted.
			// @ts-expect-error
			yield* projectsService.remove(canChange);

			// A project's members listed with no proof that it is reached, only its id.
			// @ts-expect-error
			yield* projectsService.members(project);

			yield* projectsService.addBot(canChange, yield* proveReachesBot(principal, bot));
			yield* projectsService.members(reach);
		}),
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

declare const modelProvidersService: ModelProviders.Interface;
declare const searchProvidersService: SearchProviders.Interface;

export const providersServiceMistakes = named(principal, "workspace", (principal, workspace) =>
	Effect.gen(function* () {
		const inWorkspace = yield* proveRealInWorkspace(principal, workspace);
		const canRead = yield* proveCanReadWorkspace(inWorkspace);
		const canManage = yield* proveCanManageWorkspace(inWorkspace);

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
		Effect.gen(function* () {
			const canManage = yield* proveCanManageBot(principal, bot);
			const canRestrict = yield* proveCanRestrictBot(principal, bot);
			const reach = yield* proveReachesBot(principal, bot);
			const otherIsMember = yield* proveIsMember(other);

			// A bot deleted with the proof that it may be managed, not that it may be deleted.
			// @ts-expect-error
			yield* botsService.remove(canManage);

			// A bot deleted with the proof that it may be restricted, not that it may be deleted.
			// @ts-expect-error
			yield* botsService.remove(canRestrict);

			// A bot changed with the proof that an admin may restrict it, which changes nothing of it.
			// @ts-expect-error
			yield* botsService.update(canRestrict, {});

			// A bot pinned for one principal with another's proof that it reaches it.
			// @ts-expect-error
			yield* botsService.setPinned(otherIsMember, reach, true);

			yield* botsService.remove(yield* proveCanDeleteBot(canManage));
			yield* botsService.remove(yield* proveCanDeleteBot(canRestrict));
			yield* botsService.setPinned(yield* proveIsMember(principal), reach, true);
		}),
);

declare const automationsService: ProjectAutomations.Interface;

export const projectAutomationsServiceMistakes = named(
	principal,
	"project",
	"trigger",
	(principal, project, trigger) =>
		Effect.gen(function* () {
			const reach = yield* proveRealReachesProject(principal, project);
			const canManage = yield* proveRealCanManageProject(reach);
			const canRestrict = yield* proveCanRestrictBotsProject(principal, project);

			// An automation defined by a principal that only reaches the project.
			// @ts-expect-error
			yield* automationsService.create(reach, { name: "", instructions: "", triggers: [] });

			// An automation run with the proof that its project may be managed, not that a run may be started there.
			// @ts-expect-error
			yield* automationsService.run(canManage, "automation", "request");

			// An automation changed at will by an admin who may only switch it off.
			// @ts-expect-error
			yield* automationsService.update(canRestrict, "automation", { name: "Mine" });

			// A webhook call's run accepted with no proof that the call is the trigger's.
			// @ts-expect-error
			yield* automationsService.acceptWebhook(trigger, { headers: {}, payload: {} });

			yield* automationsService.run(yield* proveCanRunAutomations(reach), "automation", "request");
			yield* automationsService.switchOff(canRestrict, "automation");
			yield* automationsService.acceptWebhook(yield* proveCallsWebhook(principal, trigger), {
				headers: {},
				payload: {},
			});
		}),
);

declare const membershipService: Membership.Interface;

export const membershipServiceMistakes = named(
	principal,
	"workspace",
	"member",
	(principal, workspace, member) =>
		Effect.gen(function* () {
			const canRead = yield* proveCanReadWorkspace(
				yield* proveRealInWorkspace(principal, workspace),
			);
			const removing = proveCanChangeMembership(principal, workspace, member, { kind: "removal" });
			const canRemove = yield* removing;

			// A workspace deleted with the proof that it may be read, not that its owner deletes it.
			// @ts-expect-error
			yield* membershipService.delete(Effect.succeed(canRead));

			// A member taken out with a proof, not the prover's effect the removal runs under the lock.
			// @ts-expect-error
			yield* membershipService.remove(canRemove);

			// A member's own workspaces listed with only the principal, not the proof a member is signed in.
			// @ts-expect-error
			yield* membershipService.workspaces(principal);

			yield* membershipService.remove(removing);
			yield* membershipService.memberships(canRead);
			yield* membershipService.workspaces(yield* proveIsMember(principal));
		}),
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

const deletesWorkspace = named(principal, "workspace", (p, w) =>
	proveCanDeleteWorkspace(p, w).pipe(Effect.asVoid),
);

// A workspace's deletion proven outside the transaction that holds its lock.
// @ts-expect-error
export const deletionOutsideTheLock: Effect.Effect<
	void,
	ResourceHidden | ActionForbidden,
	Database
> = deletesWorkspace;

const changesMembershipInTransaction = named(principal, "workspace", "member", (p, w, u) =>
	proveCanChangeMembership(p, w, u, { kind: "removal" }).pipe(Effect.asVoid),
);

// A membership change proven outside the transaction that holds the workspace's lock.
// @ts-expect-error
export const outsideTheLock: Effect.Effect<void, ResourceHidden | ActionForbidden, Database> =
	changesMembershipInTransaction;

declare const connectorsService: Connectors.Interface;
declare const gitHubConnectorsService: GitHubConnectors.Interface;
declare const delivery: { event: string; deliveryId: string; body: string };

export const connectorsServiceMistakes = named(
	principal,
	"project",
	"connector",
	(principal, project, connector) =>
		Effect.gen(function* () {
			const reach = yield* proveRealReachesProject(principal, project);
			const canRead = yield* proveCanReadConnectors(reach);
			const canManage = yield* proveRealCanManageProject(reach);

			// A connector removed with the proof that its project's connectors may be read, not managed.
			// @ts-expect-error
			yield* connectorsService.remove(canRead, "connector");

			// A project's connectors listed with no proof that they may be read, only that it is reached.
			// @ts-expect-error
			yield* connectorsService.list(reach);

			// A delivery read with the proof that its project is reached, not that its GitHub app signed it.
			// @ts-expect-error
			yield* gitHubConnectorsService.readDelivery(reach, delivery);

			yield* connectorsService.remove(canManage, "connector");
			yield* connectorsService.list(canRead);
			yield* gitHubConnectorsService.readDelivery(
				yield* proveSignedByGitHubApp(principal, connector),
				delivery,
			);
		}),
);

declare const chatsService: Chats.Interface;
declare const posted: { messageId: string; content: string };
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
		Effect.gen(function* () {
			const reach = yield* proveRealReachesChat(principal, chat);
			const changesOther = yield* proveRealCanChangeChat(
				yield* proveRealReachesChat(principal, otherChat),
			);
			const canTakePart = yield* proveRealCanTakePart(reach);

			// `CanChangeChat` proven for another chat, handed over with the reach of this one.
			// @ts-expect-error
			yield* chatsService.setResolved(reach, true, changesOther);

			// A message posted as another principal's member, in a chat this one takes part in.
			// @ts-expect-error
			yield* chatsService.post(yield* proveIsMember(other), canTakePart, posted);

			// A chat renamed with the proof that it may be changed, not that its project's chats may be managed.
			// @ts-expect-error
			yield* chatsService.renameChat(reach, "Renamed", yield* proveRealCanChangeChat(reach));

			// A page of a chat read with the reach of its project, not of the chat.
			// @ts-expect-error
			yield* chatViewService.messages(yield* proveRealReachesProject(principal, chat), firstPage);

			yield* chatsService.setResolved(reach, true, yield* proveRealCanChangeChat(reach));
			yield* chatsService.post(yield* proveIsMember(principal), canTakePart, posted);
			yield* chatsService.renameChat(reach, "Renamed", yield* proveCanManageChats(reach));
			yield* chatViewService.messages(reach, firstPage);
		}),
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

		// A call decided as another principal's member than the approver `CanDecide` found.
		// @ts-expect-error
		yield* turnControls.decide(otherMember, canDecide, "deny");

		// A call decided with no proof that the member is its approver, only its id.
		// @ts-expect-error
		yield* turnControls.decide(isMember, call, "deny");

		yield* turnControls.decide(isMember, canDecide, "deny");
	}),
);
