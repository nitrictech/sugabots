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

/** A message in a thread of a project led by `lead`, with `reviewer` and `scout` in it too. */
function input(overrides: Partial<FloorInput> = {}): FloorInput {
	return {
		conversationKind: "project_thread",
		content: "Hello",
		mentionableBots: projectBots,
		lead: { id: lead, hasModel: true },
		peopleHandles: new Set(["sam"]),
		repliedToBotId: undefined,
		...overrides,
	};
}

const turns = (...bots: Array<{ botId: string; reason: string }>) => ({ kind: "turns", bots });
const nobody = { kind: "nobody" };

describe("a person's message in a project's thread", () => {
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
		// A reply to a bot is for that bot, though it names a person.
		expect(floorOf(input({ ...replyToScout, content: "@sam what do you think?" }))).toEqual(
			turns({ botId: scout, reason: "reply" }),
		);
	});

	it("gives the lead an optional turn when it mentions only people", () => {
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
		// Mentioning a person beside one is mentioning only people.
		expect(floorOf(input({ content: "@sam and @Backlog Manager, look" }))).toEqual(
			turns({ botId: lead, reason: "optional" }),
		);
	});

	it("goes to the lead when it mentions the lead", () => {
		expect(floorOf(input({ content: "@lead-bot can you check?" }))).toEqual(
			turns({ botId: lead, reason: "mention" }),
		);
	});

	it("goes to nobody but the bots it addresses in a project with no lead yet", () => {
		expect(floorOf(input({ lead: null, content: "Morning all" }))).toEqual(nobody);
		expect(floorOf(input({ lead: null, content: "@scout?" }))).toEqual(
			turns({ botId: scout, reason: "mention" }),
		);
	});

	it("offers no optional turn to a lead with no model, which could only fail", () => {
		expect(
			floorOf(input({ lead: { id: lead, hasModel: false }, content: "@sam can you look?" })),
		).toEqual(nobody);
	});
});

describe("a person's message in an automation's feed", () => {
	const feed = (content: string): FloorInput =>
		input({ conversationKind: "automation_feed", content });

	it("goes to the project's lead bot, not to the bots mentioned", () => {
		// Another bot, a private one too, is reached by the lead collaborating.
		expect(floorOf(feed("@reviewer and @scout, thoughts?"))).toEqual(
			turns({ botId: lead, reason: "default" }),
		);
		expect(floorOf(feed("@lead-bot can you check?"))).toEqual(
			turns({ botId: lead, reason: "mention" }),
		);
	});

	it("goes to nobody when it mentions only people", () => {
		expect(floorOf(feed("@sam can you look?"))).toEqual(nobody);
		expect(floorOf(feed("@channel the report is late"))).toEqual(nobody);
	});

	it("goes to nobody in a project with no lead yet", () => {
		expect(floorOf({ ...feed("Any news?"), lead: null })).toEqual(nobody);
	});
});
