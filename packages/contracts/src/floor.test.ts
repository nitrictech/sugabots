import { describe, expect, it } from "vitest";
import { type AskingMessage, helpersAskedBy } from "./floor.ts";

const lead = "lead";
const reviewer = "reviewer";
const scout = "scout";

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
