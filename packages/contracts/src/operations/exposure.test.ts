import { describe, expect, it } from "vitest";
import { botLoopTools, type Decisions, httpOperations } from "./exposure.ts";

const manifest = {
	"chats.setResolved": {
		http: { kind: "offered", endpoint: "chats.markResolved" },
		botLoop: { kind: "offered", tool: "resolve_chat", approval: { kind: "never" } },
	},
	"chats.rename": {
		http: { kind: "offered", endpoint: "chats.renameChat" },
		botLoop: {
			kind: "coveredBy",
			operation: "chats.setResolved",
			reason: "Stand-in: covered by resolving.",
		},
	},
	"computers.runCommand": {
		http: { kind: "heldBack", reason: "Stand-in: only bots run commands." },
		botLoop: {
			kind: "offered",
			tool: "run_command",
			approval: { kind: "always", approvers: "computerManagers" },
		},
	},
	"events.followChat": {
		http: { kind: "heldBack", reason: "Stand-in: the event stream serves it." },
		botLoop: { kind: "heldBack", reason: "Stand-in: a bot reads events in its turn." },
	},
} as const satisfies Record<string, Decisions>;

describe("httpOperations", () => {
	it("lists the offered operations with their endpoints, leaving out those held back", () => {
		expect(httpOperations(manifest)).toEqual([
			{ operation: "chats.rename", endpoint: "chats.renameChat" },
			{ operation: "chats.setResolved", endpoint: "chats.markResolved" },
		]);
	});
});

describe("botLoopTools", () => {
	it("lists the tools offered, in tool name order, leaving out operations held back or covered", () => {
		expect(botLoopTools(manifest)).toEqual([
			{ operation: "chats.setResolved", tool: "resolve_chat", approval: { kind: "never" } },
			{
				operation: "computers.runCommand",
				tool: "run_command",
				approval: { kind: "always", approvers: "computerManagers" },
			},
		]);
	});

	it("keeps offering the operation that covers another", () => {
		const offered = botLoopTools(manifest).map((tool) => tool.operation);

		expect(offered).toContain(manifest["chats.rename"].botLoop.operation);
		expect(offered).not.toContain("chats.rename");
	});
});
