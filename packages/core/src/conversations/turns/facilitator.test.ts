import { describe, expect, it } from "vitest";
import { type FacilitatorScope, facilitatorPrompt, parseDecision } from "./facilitator.ts";

const scope: FacilitatorScope = {
	threadId: "t1",
	podId: "p1",
	threadType: "routine",
	workspaceId: "w1",
	model: "small-model",
	hostHandle: "host-agent",
	routerEnabled: true,
	crew: [
		{ id: "a1", name: "Host Agent", handle: "host-agent", description: null, inThread: true },
		{
			id: "a2",
			name: "Reviewer",
			handle: "reviewer",
			description: "Checks facts.",
			inThread: false,
		},
	],
	people: [{ name: "Sam", handle: "sam" }],
	recent: [
		{ speaker: "@sam", kind: "person", content: "Is the migration present?" },
		{ speaker: "@host-agent", kind: "agent", content: "@reviewer, can you confirm?" },
	],
};

describe("the facilitator", () => {
	it("reads a handle back with or without the at sign, and a person as nobody", () => {
		expect(parseDecision("@reviewer", scope)).toEqual({ kind: "agent", agentId: "a2" });
		expect(parseDecision("Reviewer.\n", scope)).toEqual({ kind: "agent", agentId: "a2" });
		expect(parseDecision("nobody", scope)).toEqual({ kind: "nobody" });
		// Naming a person is an answer: the rules ask for `nobody` when a person
		// is addressed, and saying which person is the same decision.
		expect(parseDecision("@sam", scope)).toEqual({ kind: "nobody" });
	});

	it("cannot choose an agent who is not on the list it was given", () => {
		// The agent that just spoke is left out of the scope, so naming it is not
		// a choice the facilitator can make — it is an answer worth asking again for.
		const withoutReviewer: FacilitatorScope = {
			...scope,
			crew: scope.crew.filter((member) => member.handle !== "reviewer"),
		};

		expect(parseDecision("@reviewer", withoutReviewer)).toBeUndefined();
	});

	it("treats an answer that is not one of the choices as unusable, not as nobody", () => {
		// Worth asking again rather than quietly ending the exchange, which is
		// what conflating these two did.
		expect(parseDecision("", scope)).toBeUndefined();
		expect(parseDecision("I think the reviewer should take this one", scope)).toBeUndefined();
		expect(parseDecision("@nobody-in-particular", scope)).toBeUndefined();
	});

	it("asks with the participants, the host, and the recent messages, on the host's model", () => {
		const prompt = facilitatorPrompt(scope, new AbortController().signal);

		expect(prompt.model).toBe("small-model");
		expect(prompt.system).toContain("Host: @host-agent");
		expect(prompt.system).toContain(
			"- @reviewer: Reviewer, agent (not in the thread yet). Checks facts.",
		);
		expect(prompt.system).toContain("- @sam: Sam, person");
		expect(prompt.messages).toEqual([
			{
				role: "user",
				content: [
					"@sam (person): Is the migration present?",
					"",
					"@host-agent (agent): @reviewer, can you confirm?",
					"",
					"---",
					// Named rather than left as the last line of a transcript: the
					// model was picking from the list because nothing told it which
					// message it was deciding about.
					"The last message is from @host-agent, an agent. Who speaks next?",
				].join("\n"),
			},
		]);
	});

	it("offers nobody as one of the answers, and says it is the usual one", () => {
		const prompt = facilitatorPrompt(scope, new AbortController().signal);

		// `nobody` used to be one word inside a paragraph while the handles were a
		// list. Every one of eleven decisions in a row picked from the list.
		expect(prompt.system).toContain("@host-agent, @reviewer, nobody");
		expect(prompt.system).toContain("nobody is the right answer most of the time");
		expect(prompt.system).toContain(
			"The last message is from an agent and does not put a direct question to another agent",
		);
	});
});
