export * as PodAdministration from "./pod-administration.ts";

import type {
	Agent,
	Pod,
	PodColor,
	PodMember,
	PodUpdate,
	PodVisibility,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { Context, Data, Effect, Layer } from "effect";
import {
	type AuthorizationDenied,
	joinedStanding,
	listedPodStandingsFor,
	ResourceHidden,
} from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { query, serviceOperations } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { crewAgentRow, toAgent } from "../agents/agent.ts";
import { podSeenBy } from "./pod.ts";
import { podMembers } from "./pod-reads.ts";
import { PodRepository } from "./pod-repository.ts";

/**
 * A workspace's channels, who is in them, and their bots. Channels are
 * returned as the current actor sees them, permissions and all.
 */
export interface Interface {
	/** The channels the actor is in, and the public ones they could join, by name. */
	readonly list: (input: {
		workspace: string;
	}) => Effect.Effect<Pod[], AuthorizationDenied, CurrentActor.Service>;
	/** A channel with the actor in it. */
	readonly create: (input: {
		workspace: string;
		name: string;
		slug: string;
		color?: PodColor;
		description?: string | null;
		visibility?: PodVisibility;
	}) => Effect.Effect<Pod, AuthorizationDenied | PodRepository.PodSlugTaken, CurrentActor.Service>;
	readonly update: (input: {
		podId: string;
		changes: PodUpdate;
	}) => Effect.Effect<
		Pod,
		AuthorizationDenied | EmptyPodUpdate | PodRepository.PodGone | PodRepository.PodSlugTaken,
		CurrentActor.Service
	>;
	readonly remove: (input: {
		podId: string;
	}) => Effect.Effect<void, AuthorizationDenied, CurrentActor.Service>;
	readonly members: (input: {
		podId: string;
	}) => Effect.Effect<PodMember[], AuthorizationDenied, CurrentActor.Service>;
	/** Adds `userId` to the channel. Adding somebody already in it changes nothing. */
	readonly addMember: (input: {
		podId: string;
		userId: string;
	}) => Effect.Effect<void, AuthorizationDenied | NotInWorkspace, CurrentActor.Service>;
	/** Takes `userId` out of the channel. Refuses an administrator, who belongs to every one. */
	readonly removeMember: (input: {
		podId: string;
		userId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | AdministratorInEveryChannel | NotInPod,
		CurrentActor.Service
	>;
	/** Takes the caller out of the channel, on the same terms as {@link Interface.removeMember}. */
	readonly leave: (input: {
		podId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | AdministratorInEveryChannel | NotInPod,
		CurrentActor.Service
	>;
	/** Puts the caller in a public channel. Joining one they are in changes nothing. */
	readonly join: (input: {
		podId: string;
	}) => Effect.Effect<Pod, AuthorizationDenied, CurrentActor.Service>;
	/** The channel's bots, by name. */
	readonly bots: (input: {
		podId: string;
	}) => Effect.Effect<Agent[], AuthorizationDenied, CurrentActor.Service>;
	readonly addBot: (input: {
		podId: string;
		agentId: string;
	}) => Effect.Effect<void, AuthorizationDenied | PodRepository.BotNotPublic, CurrentActor.Service>;
	readonly removeBot: (input: {
		podId: string;
		agentId: string;
	}) => Effect.Effect<void, AuthorizationDenied, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/PodAdministration",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("PodAdministration");
	const authorization = yield* Authorization.Service;
	const pods = yield* PodRepository.Service;

	const takeOut = (channel: schema.PodRow, userId: string) =>
		Effect.gen(function* () {
			const outcome = yield* pods.removeMember(channel.workspaceId, channel.id, userId);
			switch (outcome) {
				case "removed":
					return;
				case "administrator":
					return yield* new AdministratorInEveryChannel();
				case "not_a_member":
					return yield* new NotInPod();
			}
		});

	return Service.of({
		list: (input) =>
			operation(
				"list",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						input.workspace,
						"workspace.read",
					);
					const listed = yield* query((db) => listedPodStandingsFor(db, workspaceId, actor.userId));
					return listed.map(podSeenBy);
				}),
			),

		create: ({ workspace, ...input }) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(workspace, "pod.create");
					const row = yield* pods.create(workspaceId, { creatorId: actor.userId, ...input });
					return podSeenBy(joinedStanding(row, actor));
				}),
			),

		update: ({ podId, changes }) =>
			operation(
				"update",
				Effect.gen(function* () {
					const standing = yield* authorization.pod(podId, "pod.update");
					if (Object.values(changes).every((value) => value === undefined)) {
						return yield* new EmptyPodUpdate();
					}
					const updated = yield* pods.update(standing.pod.workspaceId, standing.pod.id, changes);
					return podSeenBy({ ...standing, pod: updated });
				}),
			),

		remove: ({ podId }) =>
			operation(
				"remove",
				Effect.flatMap(authorization.pod(podId, "pod.delete"), ({ pod: channel }) =>
					pods.remove(channel.workspaceId, channel.id),
				),
			),

		members: ({ podId }) =>
			operation(
				"members",
				Effect.flatMap(authorization.pod(podId, "pod.read"), ({ pod: channel }) =>
					podMembers(channel.id),
				),
			),

		addMember: ({ podId, userId }) =>
			operation(
				"addMember",
				Effect.gen(function* () {
					const { pod: channel } = yield* authorization.pod(podId, "pod.members.manage");
					const outcome = yield* pods.addMember(channel.workspaceId, channel.id, userId);
					if (outcome === "not_workspace_member") return yield* new NotInWorkspace();
				}),
			),

		removeMember: ({ podId, userId }) =>
			operation(
				"removeMember",
				Effect.gen(function* () {
					const { pod: channel } = yield* authorization.pod(podId, "pod.members.manage");
					return yield* takeOut(channel, userId);
				}),
			),

		leave: ({ podId }) =>
			operation(
				"leave",
				Effect.gen(function* () {
					const { pod: channel, actor } = yield* authorization.pod(podId, "pod.leave");
					return yield* takeOut(channel, actor.userId);
				}),
			),

		join: ({ podId }) =>
			operation(
				"join",
				Effect.gen(function* () {
					const standing = yield* authorization.podFound(podId);
					const channel = standing.pod;
					if (!standing.facts.isMember) {
						// Only a public channel is joined from the directory; a private one
						// is answered as if it weren't there.
						if (channel.visibility !== "public" || !standing.actor.workspaceRole) {
							return yield* new ResourceHidden({ resource: "pod" });
						}
						yield* pods.addMember(channel.workspaceId, channel.id, standing.actor.userId);
					}
					return podSeenBy(joinedStanding(channel, standing.actor));
				}),
			),

		bots: ({ podId }) =>
			operation(
				"bots",
				Effect.gen(function* () {
					const { pod: channel, actor } = yield* authorization.pod(podId, "pod.read");
					return (yield* pods.bots(channel.id)).flatMap((row) => {
						const crew = crewAgentRow(row);
						return crew ? [toAgent(crew, { actor })] : [];
					});
				}),
			),

		addBot: ({ podId, agentId }) =>
			operation(
				"addBot",
				Effect.gen(function* () {
					const { pod: channel } = yield* authorization.pod(podId, "pod.bots.manage");
					// A bot the person can't see is answered as if it weren't there.
					yield* authorization.agent(agentId, "agent.read");
					yield* pods.addBot(channel.workspaceId, channel.id, agentId);
				}),
			),

		removeBot: ({ podId, agentId }) =>
			operation(
				"removeBot",
				Effect.flatMap(authorization.pod(podId, "pod.bots.manage"), ({ pod: channel }) =>
					pods.removeBot(channel.workspaceId, channel.id, agentId),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, PodRepository.layer]));

/** A channel update that names nothing to change. */
export class EmptyPodUpdate extends Data.TaggedError("EmptyPodUpdate") implements UserFacing {
	get userMessage() {
		return userText`Nothing to change`;
	}
}

/** Administrators belong to every channel, so nobody takes one out of it. */
export class AdministratorInEveryChannel
	extends Data.TaggedError("AdministratorInEveryChannel")
	implements UserFacing
{
	get userMessage() {
		return userText`Administrators are in every channel`;
	}
}

/** Only a member of the channel's workspace can be added to it. */
export class NotInWorkspace extends Data.TaggedError("NotInWorkspace") implements UserFacing {
	get userMessage() {
		return userText`That person is not in this workspace`;
	}
}

export class NotInPod extends Data.TaggedError("NotInPod") implements UserFacing {
	get userMessage() {
		return userText`That person is not in this channel`;
	}
}
