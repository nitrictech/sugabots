import type { Api, Authorise } from "@sugabots/contracts/http";
import type { PodPermission, WorkspacePermission } from "@sugabots/core/workspaces/permissions";
import type { HttpApi, HttpApiGroup } from "effect/unstable/httpapi";

/**
 * What each endpoint lets the caller do, checked by `Authorise` before the
 * request is decoded.
 *
 * `workspace`, `pod` and `agent` name the permission to check against the
 * `:workspace`, `:podId` or `:agentId` in the path. `reach` is for an
 * endpoint addressed at something narrower — a thread, a chat, a turn — whose
 * store scopes the query to the pods the caller reaches; the string says
 * where, because that claim has to stay true.
 */
export type AccessRule =
	| { readonly workspace: WorkspacePermission }
	| { readonly pod: PodPermission }
	| { readonly agent: PodPermission }
	| { readonly reach: string };

type GroupsOf<Definition> =
	Definition extends HttpApi.HttpApi<infer _Id, infer Groups> ? Groups : never;

type BehindAuthorise<Endpoint> = Endpoint extends { readonly "~Middleware": infer Middleware }
	? Authorise extends Middleware
		? Endpoint
		: never
	: never;

/**
 * A rule for every endpoint behind `Authorise`, by group then endpoint, so an
 * endpoint added without one does not compile. Public endpoints have no entry,
 * and neither does a group none of whose endpoints are behind `Authorise`.
 */
type AccessPolicy = {
	readonly [Group in GroupsOf<typeof Api> as [
		BehindAuthorise<HttpApiGroup.Endpoints<Group>>,
	] extends [never]
		? never
		: Group["identifier"]]: {
		readonly [Endpoint in BehindAuthorise<
			HttpApiGroup.Endpoints<Group>
		> as Endpoint["identifier"]]: AccessRule;
	};
};

export const accessPolicy: AccessPolicy = {
	system: {
		me: { reach: "the signed-in person, and nothing about a workspace" },
		workspaceAccess: { workspace: "workspace.read" },
	},
	agents: {
		list: { workspace: "workspace.read" },
		create: { pod: "agent.create" },
		get: { agent: "agent.read" },
		update: { agent: "agent.update" },
		remove: { agent: "agent.delete" },
	},
	pods: {
		list: { workspace: "workspace.read" },
		create: { workspace: "pod.create" },
		ensurePersonal: { workspace: "workspace.read" },
		update: { pod: "pod.update" },
		remove: { pod: "pod.delete" },
		listMembers: { pod: "pod.read" },
		addMember: { pod: "pod.members.manage" },
		removeMember: { pod: "pod.members.manage" },
	},
	onboarding: {
		status: { reach: "the signed-in person's own progress" },
		complete: { reach: "onboarding/store.ts checks the pod and agent named" },
		completeInvite: { reach: "matches the invitation against this account" },
	},
	systemAgents: {
		list: { workspace: "workspace.read" },
		update: { workspace: "workspace.builtInAgents.configure" },
	},
	modelTrials: {
		run: { workspace: "workspace.providers.manage" },
	},
	modelProviders: {
		list: { workspace: "workspace.providers.manage" },
		listEnabledModels: { workspace: "workspace.read" },
		create: { workspace: "workspace.providers.manage" },
		get: { workspace: "workspace.providers.manage" },
		update: { workspace: "workspace.providers.manage" },
		remove: { workspace: "workspace.providers.manage" },
		test: { workspace: "workspace.providers.manage" },
		fetchModels: { workspace: "workspace.providers.manage" },
		startChatgptSignIn: { workspace: "workspace.providers.manage" },
		completeChatgptSignIn: { workspace: "workspace.providers.manage" },
		signOutChatgpt: { workspace: "workspace.providers.manage" },
		addModel: { workspace: "workspace.providers.manage" },
		setModelsEnabled: { workspace: "workspace.providers.manage" },
		updateModel: { workspace: "workspace.providers.manage" },
		removeModel: { workspace: "workspace.providers.manage" },
	},
	searchProviders: {
		get: { workspace: "workspace.providers.manage" },
		webAccess: { workspace: "workspace.read" },
		replace: { workspace: "workspace.providers.manage" },
		update: { workspace: "workspace.providers.manage" },
		remove: { workspace: "workspace.providers.manage" },
		test: { workspace: "workspace.providers.manage" },
	},
	sandboxProviders: {
		get: { workspace: "workspace.providers.manage" },
		replace: { workspace: "workspace.providers.manage" },
		update: { workspace: "workspace.providers.manage" },
		remove: { workspace: "workspace.providers.manage" },
		test: { workspace: "workspace.providers.manage" },
		podStatus: { pod: "pod.read" },
		discardPod: { pod: "sandbox.manage" },
	},
	connections: {
		list: { pod: "connection.read" },
		create: { pod: "connection.manage" },
		get: { pod: "connection.read" },
		update: { pod: "connection.manage" },
		remove: { pod: "connection.manage" },
		test: { pod: "connection.manage" },
		connectFromCatalog: { pod: "connection.manage" },
		startOAuth: { pod: "connection.manage" },
		oauthCallback: {
			reach: "connections/operations.ts asks again on the way back from the provider",
		},
	},
	events: {
		workspace: { reach: "events/access.ts asks Authorization itself" },
		thread: { reach: "events/access.ts asks the same thread visibility" },
	},
	chats: {
		list: { workspace: "workspace.read" },
		getOrCreate: { workspace: "workspace.read" },
		messages: { reach: "chats/store.ts scopes by visibleChat" },
		history: { reach: "chats/store.ts scopes by visibleChat" },
		send: { reach: "chats/store.ts scopes by visibleChat" },
	},
	threads: {
		list: { workspace: "workspace.read" },
		get: { reach: "threads/store.ts scopes by reachesPod" },
		activity: { reach: "threads/store.ts scopes by reachesPod" },
		cancelTurn: { reach: "turns/store.ts scopes by visibleThread" },
	},
	toolApprovals: {
		decide: { pod: "approval.decide" },
	},
	routines: {
		listInWorkspace: { workspace: "workspace.read" },
		list: { agent: "routine.read" },
		create: { agent: "routine.manage" },
		previewSchedule: { agent: "routine.manage" },
		get: { agent: "routine.read" },
		update: { agent: "routine.manage" },
		remove: { agent: "routine.manage" },
		run: { agent: "routine.run" },
		rotateSecret: { agent: "routine.manage" },
		executions: { agent: "routine.history.read" },
	},
};

/**
 * The rule for an endpoint named at runtime, as middleware sees it. `undefined`
 * only for an endpoint `Authorise` does not guard.
 */
export function accessRuleFor(group: string, endpoint: string): AccessRule | undefined {
	const rules: Readonly<Record<string, Readonly<Record<string, AccessRule>>>> = accessPolicy;
	return rules[group]?.[endpoint];
}
