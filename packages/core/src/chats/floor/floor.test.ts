import { type AskingMessage, helpersAskedBy } from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import { type FloorInput, floorOf } from "./floor.ts";

/**
 * The floor decision on its own. What each layer does, and that the
 * layers above win over the ones below.
 */

const lead = "0199a3a0-0000-7000-8000-000000000003";
const reviewer = "0199a3a0-0000-7000-8000-000000000005";
const scout = "0199a3a0-0000-7000-8000-000000000009";

const projectBots = [
	{ id: lead, handle: "lead-bot" },
	{ id: reviewer, handle: "reviewer" },
	{ id: scout, handle: "scout" },
];

/** A message in a chat of a project led by `lead`, with `reviewer` and `scout` in it too. */
function input(overrides: Partial<FloorInput> = {}): FloorInput {
	return {
		chatKind: "project_chat",
		content: "Hello",
		mentionableBots: projectBots,
		lead: { id: lead, hasModel: true },
		membersHandles: new Set(["sam"]),
		repliedToBotId: undefined,
		...overrides,
	};
}

const turns = (...bots: Array<{ botId: string; reason: string }>) => ({ kind: "turns", bots });
const nobody = { kind: "nobody" };

describe("a member's message in a project's chat", () => {
	it("goes to every project bot it mentions, each at once", () => {
		expect(floorOf(input({ content: "@reviewer and @scout, thoughts?" }))).toEqual(
			turns({ botId: reviewer, reason: "mention" }, { botId: scout, reason: "mention" }),
		);
	});

	it("goes to the project bot it replies to, unless it mentions other project bots", () => {
		const replyToScout = { repliedToBotId: scout };
		expect(floorOf(input({ ...replyToScout, content: "And the automations?" }))).toEqual(
			turns({ botId: scout, reason: "reply" }),
		);
		expect(floorOf(input({ ...replyToScout, content: "@reviewer can you check?" }))).toEqual(
			turns({ botId: reviewer, reason: "mention" }),
		);
		// A reply to a bot is for that bot, though it names a member.
		expect(floorOf(input({ ...replyToScout, content: "@sam what do you think?" }))).toEqual(
			turns({ botId: scout, reason: "reply" }),
		);
	});

	it("gives the lead an optional turn when it mentions only members", () => {
		expect(floorOf(input({ content: "@sam can you look?" }))).toEqual(
			turns({ botId: lead, reason: "optional" }),
		);
		expect(floorOf(input({ content: "@here quick poll: lunch?" }))).toEqual(
			turns({ botId: lead, reason: "optional" }),
		);
	});

	it("goes to the lead when it mentions nobody", () => {
		expect(floorOf(input({ content: "Morning all" }))).toEqual(
			turns({ botId: lead, reason: "default" }),
		);
	});

	it("ignores the bots it mentions from outside the project", () => {
		expect(floorOf(input({ content: "Raise it with @Backlog Manager" }))).toEqual(
			turns({ botId: lead, reason: "default" }),
		);
		// Mentioning a member beside one is mentioning only members.
		expect(floorOf(input({ content: "@sam and @Backlog Manager, look" }))).toEqual(
			turns({ botId: lead, reason: "optional" }),
		);
	});

	it("goes to the lead when it mentions the lead", () => {
		expect(floorOf(input({ content: "@lead-bot can you check?" }))).toEqual(
			turns({ botId: lead, reason: "mention" }),
		);
	});

	it("offers no optional turn to a lead with no model, which could only fail", () => {
		expect(
			floorOf(input({ lead: { id: lead, hasModel: false }, content: "@sam can you look?" })),
		).toEqual(nobody);
	});
});

describe("a member's message in an automation's feed", () => {
	const feed = (content: string): FloorInput => input({ chatKind: "automation_feed", content });

	it("goes to the project's lead bot, not to the bots mentioned", () => {
		// Mentions bring in no other bot here.
		expect(floorOf(feed("@reviewer and @scout, thoughts?"))).toEqual(
			turns({ botId: lead, reason: "default" }),
		);
		expect(floorOf(feed("@lead-bot can you check?"))).toEqual(
			turns({ botId: lead, reason: "mention" }),
		);
	});

	it("goes to nobody when it mentions only members", () => {
		expect(floorOf(feed("@sam can you look?"))).toEqual(nobody);
		expect(floorOf(feed("@channel the report is late"))).toEqual(nobody);
	});
});

describe("a bot's message", () => {
	/** The lead's reply in a project's chat, mentioning `mentionedBotIds`. */
	const asking = (overrides: Partial<AskingMessage> = {}): AskingMessage => ({
		chatKind: "project_chat",
		authorBotId: lead,
		mayAsk: true,
		mentionedBotIds: [reviewer, scout],
		alreadyAsked: new Set(),
		...overrides,
	});

	it("asks every other project bot it mentions for help, in a project's chat or a run", () => {
		expect(helpersAskedBy(asking())).toEqual([reviewer, scout]);
		expect(helpersAskedBy(asking({ chatKind: "run" }))).toEqual([reviewer, scout]);
	});

	it("asks nobody by mentioning its own bot", () => {
		expect(helpersAskedBy(asking({ mentionedBotIds: [lead, scout] }))).toEqual([scout]);
	});

	it("asks nobody when a helper wrote it, so collaborations go one deep", () => {
		expect(helpersAskedBy(asking({ mayAsk: false }))).toEqual([]);
	});

	it("asks nobody in an automation's feed", () => {
		expect(helpersAskedBy(asking({ chatKind: "automation_feed" }))).toEqual([]);
	});

	it("asks only the bots not already asked for the same message, brief or run", () => {
		expect(helpersAskedBy(asking({ alreadyAsked: new Set([reviewer]) }))).toEqual([scout]);
	});
});
