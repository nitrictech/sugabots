import type { Agent, Connection, Pod } from "@sugabots/contracts";
import { linkOptions } from "@tanstack/react-router";

/*
 * Where a pod or an agent lives in the workspace being looked at.
 *
 * Built from the records rather than from loose params, so no caller assembles
 * an address by hand and the address can change here alone. Each result spreads
 * into a `Link` or goes to `navigate` from a page under `/$workspace`.
 *
 * Only pod, agent and connection addresses, whose slugs, handles and ids are
 * easy to swap for one another. Pages outside a workspace (onboarding, the OAuth return) name one
 * themselves, and links by fixed key or thread id are written in place.
 */

interface AgentInPod {
	pod: Pick<Pod, "slug">;
	agent: Pick<Agent, "handle">;
}

/** What is new across the workspace. */
export function activityLink() {
	return linkOptions({ from: "/$workspace", to: "./activity" });
}

/** A pod's conversation list. */
export function podLink(pod: Pod) {
	return linkOptions({ from: "/$workspace", to: "./pods/$pod", params: { pod: pod.slug } });
}

/** A pod's artifacts. */
export function artifactsLink(pod: Pod) {
	return linkOptions({
		from: "/$workspace",
		to: "./pods/$pod/artifacts",
		params: { pod: pod.slug },
	});
}

export function artifactLink(pod: Pod, artifactId: string, search: { version?: number } = {}) {
	return linkOptions({
		from: "/$workspace",
		to: "./pods/$pod/artifacts/$artifact",
		params: { pod: pod.slug, artifact: artifactId },
		search,
	});
}

export function podSettingsLink(pod: Pod) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/pods/$pod",
		params: { pod: pod.slug },
	});
}

/** A routine's page in the workspace's Routines settings. */
export function routineSettingsLink(routine: { id: string }) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/routines/$routine",
		params: { routine: routine.id },
	});
}

/** A new routine's page, for `agent` when it is made from that bot's settings. */
export function newRoutineLink(agent?: { id: string }) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/routines/new",
		search: agent ? { agent: agent.id } : {},
	});
}

/** A connection's own page, under its pod's settings. */
export function connectionSettingsLink(pod: Pod, connection: Pick<Connection, "id">) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/pods/$pod/connections/$connection",
		params: { pod: pod.slug, connection: connection.id },
	});
}

/** A conversation in its pod. */
interface ConversationInPod {
	pod: Pick<Pod, "slug">;
	conversationId: string;
}

/** A routine run or collaboration opened from Inbox as a page of its own. */
export function activityThreadLink({ pod, conversationId }: ConversationInPod, threadId: string) {
	return linkOptions({
		from: "/$workspace",
		to: "./activity/$pod/$conversation",
		params: { pod: pod.slug, conversation: conversationId },
		search: { threadPage: threadId },
	});
}

/** A conversation, with `thread` open beside it, or `artifact` open large. */
export function conversationLink(
	{ pod, conversationId }: ConversationInPod,
	search: { thread?: string; artifact?: string } = {},
) {
	return linkOptions({
		from: "/$workspace",
		to: "./pods/$pod/threads/$conversation",
		params: { pod: pod.slug, conversation: conversationId },
		search,
	});
}

/** Starting a thread in a pod, from its first message, which names `agent` when one is given. */
export function newThreadLink(pod: Pick<Pod, "slug">, agent?: Pick<Agent, "handle">) {
	return linkOptions({
		from: "/$workspace",
		to: "./pods/$pod/threads/new",
		params: { pod: pod.slug },
		search: { agent: agent?.handle },
	});
}

/** A pod's routines, with the first open beside them where there is room. */
export function routinesLink(pod: Pick<Pod, "slug">, bot?: { handle: string }) {
	return linkOptions({
		from: "/$workspace",
		to: "./pods/$pod/routines",
		params: { pod: pod.slug },
		search: bot ? { bot: bot.handle } : {},
	});
}

/** A routine's own thread, where its runs post, beside the pod's routines; opened first when it has none yet. */
export function routineThreadLink(pod: Pick<Pod, "slug">, routineId: string) {
	return linkOptions({
		from: "/$workspace",
		to: "./pods/$pod/routines/$routine",
		params: { pod: pod.slug, routine: routineId },
	});
}

/** A pod's chat, opened first when nobody has opened it yet. */
export function podChatLink(pod: Pick<Pod, "slug">) {
	return linkOptions({ from: "/$workspace", to: "./pods/$pod/chat", params: { pod: pod.slug } });
}

/**
 * A bot's newest conversation in its pod, started if it has none, with
 * `thread` open beside it, or `artifact` open large.
 */
export function agentChatLink(
	{ pod, agent }: AgentInPod,
	search: { thread?: string; artifact?: string } = {},
) {
	return linkOptions({
		from: "/$workspace",
		to: "./pods/$pod/agents/$agent",
		params: { pod: pod.slug, agent: agent.handle },
		search,
	});
}

export function agentSettingsLink({ pod, agent }: AgentInPod) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/pods/$pod/agents/$agent",
		params: { pod: pod.slug, agent: agent.handle },
	});
}

/** A person's page among the workspace's members, by their membership's id. */
export function memberSettingsLink(membership: { id: string }) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/members/$member",
		params: { member: membership.id },
	});
}
