import type { Agent, Pod } from "@sugabots/contracts";
import { linkOptions } from "@tanstack/react-router";

/*
 * Where a pod or an agent lives in the workspace being looked at.
 *
 * Built from the records rather than from loose route params: an address takes
 * a pod's slug and an agent's handle, and an id passed in their place would
 * still type-check as a string, then open a page that is not there. Each
 * result spreads into a `Link` or goes to `navigate`, with `search` added where
 * a page needs it.
 */

type PodAddress = Pick<Pod, "slug">;

interface AgentAddress {
	pod: PodAddress;
	agent: Pick<Agent, "handle">;
}

export function podSettingsLink(pod: PodAddress) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/pods/$pod",
		params: { pod: pod.slug },
	});
}

export function agentChatLink({ pod, agent }: AgentAddress) {
	return linkOptions({
		from: "/$workspace",
		to: "./pods/$pod/agents/$agent",
		params: { pod: pod.slug, agent: agent.handle },
	});
}

export function agentSettingsLink({ pod, agent }: AgentAddress) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/pods/$pod/agents/$agent",
		params: { pod: pod.slug, agent: agent.handle },
	});
}
