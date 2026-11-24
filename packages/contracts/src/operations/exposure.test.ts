import { describe, expect, it } from "vitest";
import { botLoopTools, type Decisions, httpOperations } from "./exposure.ts";

const manifest = {
	"chats.setResolved": {
		http: { kind: "offered", endpoint: "chats.markResolved" },
		botLoop: {
			kind: "offered",
			tool: "resolve_chat",
			offeredIn: "everywhere",
			approval: { kind: "never" },
		},
	},
	"chats.rename": {
		http: { kind: "offered", endpoint: "chats.renameChat" },
		botLoop: {
			kind: "coveredBy",
			operation: "chats.setResolved",
			reason: "Stand-in: covered by resolving.",
		},
	},
	"computers.requestHost": {
		http: { kind: "heldBack", reason: "Stand-in: only bots ask for hosts." },
		botLoop: {
			kind: "offered",
			tool: "request_host",
			offeredIn: "everywhere",
			approval: { kind: "always", approvers: "computerManagers" },
		},
	},
	"automations.create": {
		http: { kind: "offered", endpoint: "automations.create" },
		botLoop: {
			kind: "offered",
			tool: "create_automation",
			offeredIn: "chatBounds",
			approval: { kind: "always", approvers: "turn" },
		},
	},
	"turns.recordStep": {
		http: { kind: "heldBack", reason: "Stand-in: the bot loop records its own steps." },
		botLoop: { kind: "calledByLoop" },
	},
	"events.followChat": {
		http: { kind: "heldBack", reason: "Stand-in: the event stream serves it." },
		botLoop: { kind: "heldBack", reason: "Stand-in: a bot reads events in its turn." },
	},
} as const satisfies Record<string, Decisions>;

describe("httpOperations", () => {
	it("lists the offered operations with their endpoints, leaving out those held back", () => {
		expect(httpOperations(manifest)).toEqual([
			{ operation: "automations.create", endpoint: "automations.create" },
			{ operation: "chats.rename", endpoint: "chats.renameChat" },
			{ operation: "chats.setResolved", endpoint: "chats.markResolved" },
		]);
	});
});

describe("botLoopTools", () => {
	it("lists the tools offered, in tool name order, with their bounds and approval", () => {
		expect(botLoopTools(manifest)).toEqual([
			{
				operation: "automations.create",
				tool: "create_automation",
				offeredIn: "chatBounds",
				approval: { kind: "always", approvers: "turn" },
			},
			{
				operation: "computers.requestHost",
				tool: "request_host",
				offeredIn: "everywhere",
				approval: { kind: "always", approvers: "computerManagers" },
			},
			{
				operation: "chats.setResolved",
				tool: "resolve_chat",
				offeredIn: "everywhere",
				approval: { kind: "never" },
			},
		]);
	});

	it("offers no tool for an operation held back, covered or called by the loop", () => {
		const offered = botLoopTools(manifest).map((tool) => tool.operation);

		expect(offered).not.toContain("chats.rename");
		expect(offered).not.toContain("turns.recordStep");
		expect(offered).not.toContain("events.followChat");
	});

	it("keeps offering the operation that covers another", () => {
		const offered = botLoopTools(manifest).map((tool) => tool.operation);

		expect(offered).toContain(manifest["chats.rename"].botLoop.operation);
	});
});
