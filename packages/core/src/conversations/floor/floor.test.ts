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
		peopleHandles: new Set(["sam"]),
		agentParticipantIds: new Set([host]),
		lastAgentSpeakerId: undefined,
		repliedToAgentId: undefined,
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

	it("goes to nobody when it mentions everyone", () => {
		expect(
			decideFloor(input({ threadType: "routine_feed", content: "@channel the report is late" })),
		).toEqual({ kind: "nobody" });
		expect(decideFloor(input({ content: "@here quick poll: lunch?" }))).toEqual({
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

	it.each(["conversation", "bot_channel", "routine_feed"] as const)(
		"goes to the bot in a %s when it mentions a handle that is nobody's",
		(threadType) => {
			expect(decideFloor(input({ threadType, content: "Raise it with @Backlog Manager" }))).toEqual(
				{ kind: "turns", agents: [{ agentId: host, reason: "default" }] },
			);
		},
	);

	it("goes to the bot a pod's chat message replies to, though it mentions a handle that is nobody's", () => {
		expect(
			decideFloor(
				input({
					threadType: "pod_chat",
					hostAgentId: null,
					repliedToAgentId: scout,
					content: "And @Backlog Manager too?",
				}),
			),
		).toEqual({ kind: "turns", agents: [{ agentId: scout, reason: "reply" }] });
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

	it("goes to the bots a pod's chat message mentions, and otherwise to nobody there", () => {
		const podChat = { threadType: "pod_chat", hostAgentId: null } as const;
		expect(decideFloor(input({ ...podChat, content: "@reviewer and @scout, thoughts?" }))).toEqual({
			kind: "turns",
			agents: [
				{ agentId: reviewer, reason: "mention" },
				{ agentId: scout, reason: "mention" },
			],
		});
		expect(decideFloor(input({ ...podChat, content: "Morning all" }))).toEqual({ kind: "nobody" });
	});

	it("goes to the bot a pod's chat message replies to, unless it mentions someone", () => {
		const replyToScout = {
			threadType: "pod_chat",
			hostAgentId: null,
			repliedToAgentId: scout,
		} as const;
		expect(decideFloor(input({ ...replyToScout, content: "And the routines?" }))).toEqual({
			kind: "turns",
			agents: [{ agentId: scout, reason: "reply" }],
		});
		expect(decideFloor(input({ ...replyToScout, content: "@reviewer can you check?" }))).toEqual({
			kind: "turns",
			agents: [{ agentId: reviewer, reason: "mention" }],
		});
		expect(decideFloor(input({ ...replyToScout, content: "@sam what do you think?" }))).toEqual({
			kind: "nobody",
		});
	});

	it("goes to the bots a conversation between people names, and otherwise to nobody there", () => {
		expect(decideFloor(input({ hostAgentId: null, content: "@reviewer?" }))).toEqual({
			kind: "turns",
			agents: [{ agentId: reviewer, reason: "mention" }],
		});
		expect(decideFloor(input({ hostAgentId: null, content: "Lunch?" }))).toEqual({
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
