import { describe, expect, it } from "vitest";
import type { TurnReason } from "../../database/schema.ts";
import { decideFloor, type FloorInput, MAX_AGENT_RUN } from "./floor.ts";

/**
 * The floor decision on its own (ADR 004). What each layer does, and that the
 * layers above win over the ones below.
 */

const host = "0199a3a0-0000-7000-8000-000000000003";
const reviewer = "0199a3a0-0000-7000-8000-000000000005";
const scout = "0199a3a0-0000-7000-8000-000000000009";

function input(overrides: Partial<FloorInput> = {}): FloorInput {
	return {
		routing: { facilitator: true },
		threadType: "chat",
		author: { kind: "person" },
		content: "Hello",
		hostAgentId: host,
		crew: [
			{ id: host, handle: "host-agent" },
			{ id: reviewer, handle: "reviewer" },
			{ id: scout, handle: "scout" },
		],
		agentParticipantIds: new Set([host]),
		lastAgentSpeakerId: undefined,
		agentRun: 0,
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
			why: "people-addressed",
		});
	});

	it("is routed in a routine when several agents are present and the facilitator is on", () => {
		expect(
			decideFloor(input({ threadType: "routine", agentParticipantIds: new Set([host, reviewer]) })),
		).toEqual({
			kind: "facilitate",
		});
	});

	it("goes to the chat's agent in a chat, not to the agents mentioned", () => {
		// The chat's agent brings a mentioned agent in by collaborating. Handing
		// the mentioned agent the turn made it a participant of the chat, and
		// every later message then went to it as the last speaker.
		expect(decideFloor(input({ content: "@reviewer, thoughts?" }))).toEqual({
			kind: "turns",
			agents: [{ agentId: host, reason: "default" }],
		});
	});

	it("goes to nobody in a chat when only people are mentioned", () => {
		// The chat's agent used to answer anyway, only to say the message was not for it.
		expect(decideFloor(input({ content: "@sam can you look?" }))).toEqual({
			kind: "nobody",
			why: "people-addressed",
		});
	});

	it("goes to the chat's agent in a chat, even after another agent spoke there", () => {
		expect(
			decideFloor(
				input({
					routing: { facilitator: false },
					agentParticipantIds: new Set([host, reviewer]),
					lastAgentSpeakerId: reviewer,
				}),
			),
		).toEqual({ kind: "turns", agents: [{ agentId: host, reason: "default" }] });
	});

	it("does not let the facilitator introduce a speaker in a chat", () => {
		expect(decideFloor(input({ agentParticipantIds: new Set([host, reviewer]) }))).toEqual({
			kind: "turns",
			agents: [{ agentId: host, reason: "default" }],
		});
	});

	it("falls to the host with one agent present, even with the facilitator on", () => {
		expect(decideFloor(input())).toEqual({
			kind: "turns",
			agents: [{ agentId: host, reason: "default" }],
		});
	});

	it("falls to the agent that spoke last when the facilitator is off", () => {
		expect(
			decideFloor(
				input({
					threadType: "routine",
					routing: { facilitator: false },
					agentParticipantIds: new Set([host, reviewer]),
					lastAgentSpeakerId: reviewer,
				}),
			),
		).toEqual({ kind: "turns", agents: [{ agentId: reviewer, reason: "default" }] });
	});

	it("ignores a last speaker who has since left the thread", () => {
		expect(
			decideFloor(
				input({
					threadType: "routine",
					routing: { facilitator: false },
					lastAgentSpeakerId: scout,
				}),
			),
		).toEqual({ kind: "turns", agents: [{ agentId: host, reason: "default" }] });
	});
});

describe("an agent's message", () => {
	const spoke = (spokeBecause: TurnReason = "facilitator") =>
		({
			kind: "agent",
			agentId: host,
			spokeBecause,
		}) as const;

	it("ends the exchange in a chat when the facilitator is off", () => {
		expect(
			decideFloor(
				input({
					author: spoke(),
					routing: { facilitator: false },
					agentRun: 1,
				}),
			),
		).toEqual({ kind: "nobody", why: "exchange-over" });
	});

	it("does not facilitate after an agent speaks in a chat", () => {
		expect(decideFloor(input({ author: spoke(), agentRun: 1 }))).toEqual({
			kind: "nobody",
			why: "exchange-over",
		});
	});

	it("still facilitates after an agent speaks in a routine", () => {
		expect(
			decideFloor(input({ threadType: "routine", author: spoke("routine"), agentRun: 1 })),
		).toEqual({ kind: "facilitate" });
	});

	it("gives the floor back to the person who named it, once it has answered", () => {
		// Mentioning one agent means that agent and nobody else. Routing the
		// reply let the host add a last word to an answer nobody asked it for.
		expect(decideFloor(input({ author: spoke("mention"), agentRun: 1 }))).toEqual({
			kind: "nobody",
			why: "answered-the-person",
		});
	});

	it("is paused once agents have talked among themselves for too long", () => {
		expect(decideFloor(input({ author: spoke(), agentRun: MAX_AGENT_RUN }))).toEqual({
			kind: "nobody",
			why: "paused",
		});
	});
});
