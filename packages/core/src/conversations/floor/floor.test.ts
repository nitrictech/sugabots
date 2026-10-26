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
		peopleOnly: false,
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
			decideFloor(input({ threadType: "routine", content: "@reviewer and @scout, thoughts?" })),
		).toEqual({
			kind: "turns",
			agents: [
				{ agentId: reviewer, reason: "mention" },
				{ agentId: scout, reason: "mention" },
			],
		});
	});

	it("goes to nobody when only people are mentioned", () => {
		expect(decideFloor(input({ threadType: "routine", content: "@sam can you look?" }))).toEqual({
			kind: "nobody",
		});
	});

	it("goes to the chat's agent in a chat, not to the agents mentioned", () => {
		// The chat's agent brings a mentioned agent in by collaborating. Handing
		// the mentioned agent the turn made it a participant of the chat.
		expect(decideFloor(input({ content: "@reviewer, thoughts?" }))).toEqual({
			kind: "turns",
			agents: [{ agentId: host, reason: "default" }],
		});
	});

	it("goes to nobody in a chat when only people are mentioned", () => {
		// The chat's agent used to answer anyway, only to say the message was not for it.
		expect(decideFloor(input({ content: "@sam can you look?" }))).toEqual({ kind: "nobody" });
	});

	it("goes to nobody when written for people only, even with an agent mentioned", () => {
		expect(
			decideFloor(input({ peopleOnly: true, content: "Should we let @reviewer take this?" })),
		).toEqual({ kind: "nobody" });
	});

	it("goes to the chat's agent in a chat with several agents in it", () => {
		expect(decideFloor(input({ agentParticipantIds: new Set([host, reviewer]) }))).toEqual({
			kind: "turns",
			agents: [{ agentId: host, reason: "default" }],
		});
	});

	it("falls to the agent that spoke last when nobody is mentioned", () => {
		expect(
			decideFloor(
				input({
					threadType: "routine",
					agentParticipantIds: new Set([host, reviewer]),
					lastAgentSpeakerId: reviewer,
				}),
			),
		).toEqual({ kind: "turns", agents: [{ agentId: reviewer, reason: "default" }] });
	});

	it("ignores a last speaker who has since left the thread", () => {
		expect(decideFloor(input({ threadType: "routine", lastAgentSpeakerId: scout }))).toEqual({
			kind: "turns",
			agents: [{ agentId: host, reason: "default" }],
		});
	});
});
