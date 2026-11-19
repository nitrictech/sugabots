import { describe, expect, it } from "vitest";
import { decideFloor, type FloorInput } from "./floor.ts";

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

/** A message in one of `lead`'s own threads, in its default project, where it is the only bot. */
function botsOwnThread(overrides: Partial<FloorInput> = {}): FloorInput {
	return input({ mentionableBots: [{ id: lead, handle: "lead-bot" }], ...overrides });
}

const turns = (...bots: Array<{ botId: string; reason: string }>) => ({ kind: "turns", bots });

describe("a person's message in a project's thread", () => {
	it("goes to every project bot it mentions, each at once", () => {
		expect(decideFloor(input({ content: "@reviewer and @scout, thoughts?" }))).toEqual(
			turns({ botId: reviewer, reason: "mention" }, { botId: scout, reason: "mention" }),
		);
	});

	it("goes to the project bot it replies to, unless it mentions other project bots", () => {
		const replyToScout = { repliedToBotId: scout };
		expect(decideFloor(input({ ...replyToScout, content: "And the automations?" }))).toEqual(
			turns({ botId: scout, reason: "reply" }),
		);
		expect(decideFloor(input({ ...replyToScout, content: "@reviewer can you check?" }))).toEqual(
			turns({ botId: reviewer, reason: "mention" }),
		);
		// A reply to a bot is for that bot, though it names a person.
		expect(decideFloor(input({ ...replyToScout, content: "@sam what do you think?" }))).toEqual(
			turns({ botId: scout, reason: "reply" }),
		);
	});

	it("gives the lead an optional turn when it mentions only people", () => {
		expect(decideFloor(input({ content: "@sam can you look?" }))).toEqual(
			turns({ botId: lead, reason: "optional" }),
		);
		expect(decideFloor(input({ content: "@here quick poll: lunch?" }))).toEqual(
			turns({ botId: lead, reason: "optional" }),
		);
	});

	it("goes to the lead when it mentions nobody", () => {
		expect(decideFloor(input({ content: "Morning all" }))).toEqual(
			turns({ botId: lead, reason: "default" }),
		);
	});

	it("ignores the bots it mentions from outside the project", () => {
		expect(decideFloor(input({ content: "Raise it with @Backlog Manager" }))).toEqual(
			turns({ botId: lead, reason: "default" }),
		);
		// Mentioning a person beside one is mentioning only people.
		expect(decideFloor(input({ content: "@sam and @Backlog Manager, look" }))).toEqual(
			turns({ botId: lead, reason: "optional" }),
		);
	});

	it("goes to the lead when it mentions the lead", () => {
		expect(decideFloor(input({ content: "@lead-bot can you check?" }))).toEqual(
			turns({ botId: lead, reason: "mention" }),
		);
	});

	it("goes to nobody but the bots it addresses in a project with no lead yet", () => {
		expect(decideFloor(input({ lead: null, content: "Morning all" }))).toEqual({ kind: "nobody" });
		expect(decideFloor(input({ lead: null, content: "@scout?" }))).toEqual(
			turns({ botId: scout, reason: "mention" }),
		);
	});

	it("offers no optional turn to a lead with no model, which could only fail", () => {
		expect(
			decideFloor(input({ lead: { id: lead, hasModel: false }, content: "@sam can you look?" })),
		).toEqual({ kind: "nobody" });
	});
});

describe("a person's message in a bot's own thread", () => {
	it("always goes to the bot, whichever other bots it mentions", () => {
		expect(decideFloor(botsOwnThread({ content: "@reviewer, thoughts?" }))).toEqual(
			turns({ botId: lead, reason: "default" }),
		);
		expect(decideFloor(botsOwnThread({ content: "Hello" }))).toEqual(
			turns({ botId: lead, reason: "default" }),
		);
	});

	it("gives the bot an optional turn when it mentions only people", () => {
		expect(decideFloor(botsOwnThread({ content: "@sam can you look?" }))).toEqual(
			turns({ botId: lead, reason: "optional" }),
		);
	});
});

describe("a person's message in an automation's feed", () => {
	const feed = (content: string): FloorInput =>
		input({ conversationKind: "automation_feed", content });

	it("goes to the project's lead bot, not to the bots mentioned", () => {
		// Another bot, a private one too, is reached by the lead collaborating.
		expect(decideFloor(feed("@reviewer and @scout, thoughts?"))).toEqual(
			turns({ botId: lead, reason: "default" }),
		);
		expect(decideFloor(feed("@lead-bot can you check?"))).toEqual(
			turns({ botId: lead, reason: "mention" }),
		);
	});

	it("goes to nobody when it mentions only people", () => {
		expect(decideFloor(feed("@sam can you look?"))).toEqual({ kind: "nobody" });
		expect(decideFloor(feed("@channel the report is late"))).toEqual({ kind: "nobody" });
	});

	it("goes to nobody in a project with no lead yet", () => {
		expect(decideFloor({ ...feed("Any news?"), lead: null })).toEqual({ kind: "nobody" });
	});
});

describe("a direct message", () => {
	it("goes to nobody", () => {
		expect(
			decideFloor(input({ conversationKind: "direct_message", lead: null, content: "Hi" })),
		).toEqual({ kind: "nobody" });
	});
});
