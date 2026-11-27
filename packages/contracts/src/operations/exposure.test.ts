import { describe, expect, it } from "vitest";
import { type BotLoopDecision, botLoopTools } from "./exposure.ts";

const contracts = {
	"chats.setResolved": {
		botLoop: {
			kind: "offered",
			tool: "resolve_chat",
			offeredIn: "everywhere",
			approval: { kind: "never" },
			personalBotAsks: true,
		},
	},
	"chats.rename": {
		botLoop: {
			kind: "coveredBy",
			operation: "chats.setResolved",
			reason: "Stand-in: covered by resolving.",
		},
	},
	"computers.requestHost": {
		botLoop: {
			kind: "offered",
			tool: "request_host",
			offeredIn: "everywhere",
			approval: { kind: "always", approvers: "computerManagers" },
			personalBotAsks: true,
		},
	},
	"automations.create": {
		botLoop: {
			kind: "offered",
			tool: "create_automation",
			offeredIn: "chatBounds",
			approval: { kind: "always", approvers: "turn" },
			personalBotAsks: true,
		},
	},
	"events.followChat": {
		botLoop: { kind: "heldBack", reason: "Stand-in: a bot reads events in its turn." },
	},
} as const satisfies Record<string, { botLoop: BotLoopDecision }>;

describe("botLoopTools", () => {
	it("lists the tools offered, in tool name order, with their bounds and approval", () => {
		expect(botLoopTools(contracts)).toEqual([
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
});
