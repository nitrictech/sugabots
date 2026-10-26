import { describe, expect, it } from "vitest";
import { decideFloor, type FloorInput } from "./floor.ts";

/**
 * The floor decision on its own. What each layer does, and that the
 * layers above win over the ones below.
 */

const host = "0199a3a0-0000-7000-8000-000000000003";
const reviewer = "0199a3a0-0000-7000-8000-000000000005";
const scout = "0199a3a0-0000-7000-8000-000000000009";

function input(overrides: Partial<FloorInput> = {}): FloorInput {
	return {
		threadType: "conversation",
		content: "Hello",
		hostAgentId: host,
		crew: [
			{ id: host, handle: "host-agent" },
			{ id: reviewer, handle: "reviewer" },
			{ id: scout, handle: "scout" },
		],
		agentParticipantIds: new Set([host]),
		lastAgentSpeakerId: undefined,
		...overrides,
	};
}

describe("a person's message", () => {
	it("goes to the agents mentioned, whether or not they are in the thread yet", () => {
		expect(
			decideFloor(
				input({ threadType: "routine_feed", content: "@reviewer and @scout, thoughts?" }),
			),
		).toEqual({
			kind: "turns",
			agents: [
				{ agentId: reviewer, reason: "mention" },
				{ agentId: scout, reason: "mention" },
			],
		});
	});

	it("goes to nobody when only people are mentioned", () => {
		expect(
			decideFloor(input({ threadType: "routine_feed", content: "@sam can you look?" })),
		).toEqual({
			kind: "nobody",
		});
	});

	it("goes to the conversation's bot, not to the bots mentioned", () => {
		// The conversation's bot brings a mentioned bot in by collaborating.
		expect(decideFloor(input({ content: "@reviewer, thoughts?" }))).toEqual({
			kind: "turns",
			agents: [{ agentId: host, reason: "default" }],
		});
	});

	it("goes to nobody in a conversation when only people are mentioned", () => {
		expect(decideFloor(input({ content: "@sam can you look?" }))).toEqual({ kind: "nobody" });
	});

	it("goes to the conversation's bot when it is mentioned", () => {
		expect(decideFloor(input({ content: "@host-agent can you check?" }))).toEqual({
			kind: "turns",
			agents: [{ agentId: host, reason: "mention" }],
		});
	});

	it("goes to the conversation's bot when several bots are in it", () => {
		expect(decideFloor(input({ agentParticipantIds: new Set([host, reviewer]) }))).toEqual({
			kind: "turns",
			agents: [{ agentId: host, reason: "default" }],
		});
	});

	it("falls to the agent that spoke last when nobody is mentioned", () => {
		expect(
			decideFloor(
				input({
					threadType: "routine_feed",
					agentParticipantIds: new Set([host, reviewer]),
					lastAgentSpeakerId: reviewer,
				}),
			),
		).toEqual({ kind: "turns", agents: [{ agentId: reviewer, reason: "default" }] });
	});

	it("goes to nobody in a pod's chat or a conversation between people", () => {
		expect(
			decideFloor(input({ threadType: "pod_chat", hostAgentId: null, content: "@reviewer?" })),
		).toEqual({ kind: "nobody" });
		expect(decideFloor(input({ hostAgentId: null, content: "@reviewer?" }))).toEqual({
			kind: "nobody",
		});
	});

	it("ignores a last speaker who has since left the thread", () => {
		expect(decideFloor(input({ threadType: "routine_feed", lastAgentSpeakerId: scout }))).toEqual({
			kind: "turns",
			agents: [{ agentId: host, reason: "default" }],
		});
	});
});
