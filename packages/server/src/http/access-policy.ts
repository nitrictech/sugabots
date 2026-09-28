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
 * service scopes the query to the pods the caller reaches; the string says
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
	onboarding: {
		status: { reach: "the signed-in person's own progress" },
		complete: { reach: "Onboarding.complete checks the pod and agent named" },
		completeInvite: { reach: "matches the invitation against this account" },
	},
	modelTrials: {
		run: { workspace: "workspace.providers.manage" },
	},
	events: {
		workspace: { reach: "events/access.ts asks Authorization itself" },
		thread: { reach: "events/access.ts asks the same thread visibility" },
	},
	chats: {
		list: { workspace: "workspace.read" },
		getOrCreate: { workspace: "workspace.read" },
		messages: { reach: "ChatView.messages scopes by reachesPod" },
		history: { reach: "ChatView.history scopes by reachesPod" },
		send: { reach: "Chats.post scopes by visibleChat" },
	},
	threads: {
		list: { workspace: "workspace.read" },
		get: { reach: "ThreadView.getVisible scopes by reachesPod" },
		activity: { reach: "ThreadView.activity scopes by reachesPod" },
		cancelTurn: { reach: "TurnExecution.requestCancel scopes by visibleThread" },
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
