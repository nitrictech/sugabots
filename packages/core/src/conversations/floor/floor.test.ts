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
		conversationKind: "task",
		content: "Hello",
		conversationBotId: host,
		mentionableBots: [
			{ id: host, handle: "host-bot" },
			{ id: reviewer, handle: "reviewer" },
			{ id: scout, handle: "scout" },
		],
		peopleHandles: new Set(["sam"]),
		repliedToBotId: undefined,
		...overrides,
	};
}

describe("a person's message", () => {
	it("goes to an automation's own bot in its conversation, not to the bots mentioned", () => {
		// Another bot, a private one too, is reached by the automation's bot collaborating.
		expect(
			decideFloor(
				input({ conversationKind: "automation_feed", content: "@reviewer and @scout, thoughts?" }),
			),
		).toEqual({ kind: "turns", bots: [{ botId: host, reason: "default" }] });
	});

	it("goes to nobody when only people are mentioned", () => {
		expect(
			decideFloor(input({ conversationKind: "automation_feed", content: "@sam can you look?" })),
		).toEqual({
			kind: "nobody",
		});
	});

	it("goes to nobody when it mentions everyone", () => {
		expect(
			decideFloor(
				input({ conversationKind: "automation_feed", content: "@channel the report is late" }),
			),
		).toEqual({ kind: "nobody" });
		expect(decideFloor(input({ content: "@here quick poll: lunch?" }))).toEqual({
			kind: "nobody",
		});
	});

	it("goes to the conversation's bot, not to the bots mentioned", () => {
		// The conversation's bot brings a mentioned bot in by collaborating.
		expect(decideFloor(input({ content: "@reviewer, thoughts?" }))).toEqual({
			kind: "turns",
			bots: [{ botId: host, reason: "default" }],
		});
	});

	it("goes to nobody in a task when only people are mentioned", () => {
		expect(decideFloor(input({ content: "@sam can you look?" }))).toEqual({ kind: "nobody" });
	});

	it.each(["task", "automation_feed"] as const)(
		"goes to the bot in a %s when it mentions a handle that is nobody's",
		(conversationKind) => {
			expect(
				decideFloor(input({ conversationKind, content: "Raise it with @Backlog Manager" })),
			).toEqual({ kind: "turns", bots: [{ botId: host, reason: "default" }] });
		},
	);

	it("goes to the bot a channel message replies to, though it mentions a handle that is nobody's", () => {
		expect(
			decideFloor(
				input({
					conversationKind: "channel_conversation",
					conversationBotId: null,
					repliedToBotId: scout,
					content: "And @Backlog Manager too?",
				}),
			),
		).toEqual({ kind: "turns", bots: [{ botId: scout, reason: "reply" }] });
	});

	it("goes to the conversation's bot when it is mentioned", () => {
		expect(decideFloor(input({ content: "@host-bot can you check?" }))).toEqual({
			kind: "turns",
			bots: [{ botId: host, reason: "mention" }],
		});
	});

	it("goes to the bots a message in a channel's conversation mentions, and otherwise to nobody there", () => {
		const channelConversation = {
			conversationKind: "channel_conversation",
			conversationBotId: null,
		} as const;
		expect(
			decideFloor(input({ ...channelConversation, content: "@reviewer and @scout, thoughts?" })),
		).toEqual({
			kind: "turns",
			bots: [
				{ botId: reviewer, reason: "mention" },
				{ botId: scout, reason: "mention" },
			],
		});
		expect(decideFloor(input({ ...channelConversation, content: "Morning all" }))).toEqual({
			kind: "nobody",
		});
	});

	it("goes to the bot a channel message replies to, unless it mentions other bots", () => {
		const replyToScout = {
			conversationKind: "channel_conversation",
			conversationBotId: null,
			repliedToBotId: scout,
		} as const;
		expect(decideFloor(input({ ...replyToScout, content: "And the automations?" }))).toEqual({
			kind: "turns",
			bots: [{ botId: scout, reason: "reply" }],
		});
		expect(decideFloor(input({ ...replyToScout, content: "@reviewer can you check?" }))).toEqual({
			kind: "turns",
			bots: [{ botId: reviewer, reason: "mention" }],
		});
		expect(decideFloor(input({ ...replyToScout, content: "@sam what do you think?" }))).toEqual({
			kind: "turns",
			bots: [{ botId: scout, reason: "reply" }],
		});
	});
});
