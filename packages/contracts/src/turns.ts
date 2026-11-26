/**
 * What the bot loop and core hand each other about a turn through the
 * operations the loop calls itself. None of it crosses a wire: the loop runs
 * in the server's process, so the values that only it and core use are
 * declared by their types and checked no deeper than their shape.
 */

import { UserText } from "@sugabots/errors";
import { Schema } from "effect";
import type { BotColor, BotVisibility } from "./bots.ts";
import type { ChatKind } from "./messages.ts";

/**
 * Why a bot was given a turn: a member mentioned it or replied to it, it was the default,
 * it leads a project whose chat got a message mentioning only members (`optional`: it
 * may stay silent), another bot's message mentioned it to ask for its help
 * (`collaboration`: it is that bot's helper), an automation ran, the bots it
 * asked for help have all answered (`hand_back`), it opened its setup
 * interview, or a bot started its chat for a member and briefed it.
 */
export const turnReasonSchema = Schema.Literals([
	"mention",
	"reply",
	"default",
	"optional",
	"collaboration",
	// An automation ran, whatever started it: a routine, a trigger or somebody by hand.
	"automation",
	"hand_back",
	"interview",
	"brief",
]);
export type TurnReason = typeof turnReasonSchema.Type;

/**
 * Where a turn is and who works in it, as its step needs to know to offer
 * its bot's tools: the chat, the bot, the project, and who the turn acts for.
 */
export interface TurnSetting {
	readonly chat: {
		readonly id: string;
		readonly workspaceId: string;
		readonly title: string;
		readonly kind: ChatKind;
		/** The bot the chat is with; none in a project members made. */
		readonly botId: string | null;
	};
	readonly bot: {
		readonly id: string;
		readonly name: string;
		readonly handle: string;
		readonly model: string;
		/** Whether its model takes images, which tools can then show it. */
		readonly acceptsImages: boolean;
		/** What it is told to be: its own instructions, or for a Personal Assistant, Sugabots'. */
		readonly instructions: string;
		/** On a Personal Assistant: the member it is for, who made it. */
		readonly assistantOf: string | null;
		/** Whether everyone in the workspace reaches it, or only its creator. */
		readonly visibility: BotVisibility;
		/** Built-in tools an admin switched off for this bot, by key. */
		readonly disabledTools: readonly string[];
		/** Whether somebody let this bot use a computer. */
		readonly usesComputer: boolean;
		/** Whether it browses so members watching its desktop can follow. */
		readonly naturalBrowsing: boolean;
		/** Its colour, which its desktop in the computer is drawn in. */
		readonly color: BotColor;
		/** Its default project, whose connectors it brings wherever it works; none for a system bot. */
		readonly defaultProjectId: string | null;
	};
	/**
	 * The project whose computer, connectors and automations the turn works
	 * with: the one its chat, automation feed or run is in. None for a system
	 * bot.
	 */
	readonly projectId: string | null;
	/** Why this bot has the turn. */
	readonly reason: TurnReason;
	/**
	 * The project members made that the chat is in, by name and slug;
	 * none in a bot's own chat, its chats in its default project
	 * included.
	 */
	readonly project: { readonly name: string; readonly slug: string } | null;
	readonly workspaceName: string;
	readonly workspaceSlug: string;
	/** The workspace's timezone, which the routines the bot sets up run in. */
	readonly workspaceTimeZone: string;
	/**
	 * The member whose message this turn answers, who the bot acts for when
	 * it changes something on their behalf: for a helper or a hand-back, the
	 * asker of the turn whose reply asked. None when it answers a bot's brief
	 * or an automation's trigger.
	 */
	readonly askerId: string | null;
	/**
	 * On a bot's brief, the member the bot started the chat for, as on the
	 * helpers and hand-backs of the turn answering it. The bot may mark this
	 * chat resolved for them, and nothing more: the brief is a bot's words, not
	 * theirs, so it never vouches for anything else they could do, such as
	 * starting another chat or changing instructions.
	 */
	readonly startedFor: string | null;
	/** What the Compaction bot left in place of older history, once the chat has been compacted. */
	readonly compaction: TurnCompaction | undefined;
}

export interface TurnCompaction {
	/** The Compaction bot's condensed account of the messages from `historyStartsAt` to `keptFrom`. */
	readonly condensed: string;
	/** History before this is neither condensed nor read, only searched. */
	readonly historyStartsAt: Date;
	/** Where the messages the bot reads word for word start. */
	readonly keptFrom: Date;
}

export const turnSettingSchema = Schema.declare(
	(value: unknown): value is TurnSetting =>
		typeof value === "object" && value !== null && "chat" in value && "bot" in value,
	{ title: "TurnSetting" },
);

/**
 * What an approved call must still match when it runs, beyond its tool and
 * input: for a connector's tool, the connector configured as it was when
 * the member allowed it. A built-in tool is the same tool wherever it runs.
 */
export const approvalBindingSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("connector"),
		connectorId: Schema.String,
		connectorRevision: Schema.Int,
		remoteToolName: Schema.String,
	}),
	Schema.Struct({ kind: Schema.Literal("built-in") }),
]);
export type ApprovalBinding = typeof approvalBindingSchema.Type;

/**
 * What the model is given back for a tool call, as the model SDK shapes it:
 * its text, JSON, error, content parts or a denial, tagged by `type`.
 */
export interface ToolResultOutput {
	readonly type: string;
}

export const toolResultOutputSchema = Schema.declare(
	(value: unknown): value is ToolResultOutput =>
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string",
	{ title: "ToolResultOutput" },
);

/**
 * What a call waits for approval of: the tool, the input it gives it, what
 * that must still match when it runs, and whether it may change something.
 */
export const approvalAskedSchema = Schema.Struct({
	tool: Schema.String,
	input: Schema.Unknown,
	binding: approvalBindingSchema,
	writeOrDelete: Schema.Boolean,
	reason: Schema.optional(Schema.String),
	computerProjectId: Schema.optional(Schema.String),
	connectorAccess: Schema.optional(Schema.Literals(["allow", "ask"])),
});
export type ApprovalAsked = typeof approvalAskedSchema.Type;

/**
 * How one of a step's calls is to be made, decided once the model made it
 * and kept before any of the step's calls is sent: sent at once, or first
 * put to its approvers. A step taken again keeps to it, and asks for
 * approval besides where the call needs one now.
 */
export const callPlanSchema = Schema.Union([
	Schema.TaggedStruct("Dispatch", {}),
	Schema.TaggedStruct("AskApproval", { asked: approvalAskedSchema }),
]);
export type CallPlan = typeof callPlanSchema.Type;

/** One of a step's tool calls, as the model made it, with what it is given back once it has that. */
export const stepCallSchema = Schema.Struct({
	toolCallId: Schema.String,
	toolName: Schema.String,
	input: Schema.Unknown,
	/** How the call is to be made, once the step decided it. */
	plan: Schema.optional(callPlanSchema),
	result: Schema.optional(toolResultOutputSchema),
});
export type StepCall = typeof stepCallSchema.Type;

/** A call of the last step that waits for approval, and what it must still match to run. */
const stepApprovalSchema = Schema.Struct({
	approvalId: Schema.String,
	toolCallId: Schema.String,
	tool: Schema.String,
	binding: approvalBindingSchema,
});
export type StepApproval = typeof stepApprovalSchema.Type;

/** A call of the last step that waited for approval, with how its approver decided it so far. */
export const decidedStepApprovalSchema = Schema.Struct({
	...stepApprovalSchema.fields,
	/** `withdrawn` when its asker steered the turn before anyone decided it. */
	decision: Schema.Literals(["pending", "allowed", "denied", "withdrawn"]),
});
export type DecidedStepApproval = typeof decidedStepApprovalSchema.Type;

/**
 * A tool the step offers the model, as its model request sends it: its
 * name, what it does, and the JSON Schema of its input.
 */
export const offeredToolSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.optional(Schema.String),
	inputSchema: Schema.Record(Schema.String, Schema.Unknown),
});
export type OfferedTool = typeof offeredToolSchema.Type;

/**
 * The facts about one turn's tools that the bot is told, gathered when its
 * first step's prompt is made: what it has, where to find the rest, and its
 * computer.
 */
export const turnEnvironmentSchema = Schema.Struct({
	/** The built-in tools on offer this turn, by key, so the bot is told it has them. */
	builtInTools: Schema.Array(Schema.String),
	/** How to find the tools in the catalog, and which are there. */
	toolCatalog: Schema.UndefinedOr(Schema.String),
	computer: Schema.UndefinedOr(Schema.String),
});
export type TurnEnvironment = typeof turnEnvironmentSchema.Type;

/** A tool call a step's model request made. `invalid` says what was wrong with its input, if anything. */
export const requestedCallSchema = Schema.Struct({
	toolCallId: Schema.String,
	toolName: Schema.String,
	input: Schema.Unknown,
	invalid: Schema.optional(Schema.String),
});
export type RequestedCall = typeof requestedCallSchema.Type;

/** How a turn's run ends, as the loop records it. */
export type TurnEnding =
	/**
	 * The model answered without calling a tool. With `noMoreSteps`, the turn
	 * may take no more, so a steer no step has read starts a turn of its own.
	 */
	| { readonly kind: "answered"; readonly noMoreSteps?: boolean }
	/**
	 * The run failed; it runs again only if `mayRunAgain` and the turn allows
	 * it, no sooner than `retryAfterMillis` from now when the provider said.
	 */
	| {
			readonly kind: "failed";
			readonly userMessage: UserText;
			readonly mayRunAgain: boolean;
			readonly retryAfterMillis?: number;
	  }
	/** The run was stopped short, as it was asked to. */
	| { readonly kind: "cancelled" };

/** What a tool call returned, or how it failed. */
export const callOutcomeSchema = Schema.Union([
	Schema.Struct({ output: Schema.Unknown }),
	Schema.Struct({ error: UserText.schema }),
]);

/**
 * What recording a tool call as sent found, before it is sent. Each call is
 * recorded once, under its turn, its step and the model's id for it, with
 * the tool it is bound to and whether it may change something, so a call an
 * earlier execution of the turn recorded is not sent again: one it finished
 * keeps what came back; one it sent and never finished that may have changed
 * something is recorded as interrupted, and members are told to check what it
 * did. One that changes nothing is sent again, once an execution, and only if
 * its tool is still the one it was sent to.
 */
export const callRecordSchema = Schema.Union([
	/** Send the call now, recorded as `id`. */
	Schema.TaggedStruct("Send", { id: Schema.String }),
	/** An earlier execution finished the call. */
	Schema.TaggedStruct("Finished", { id: Schema.String, outcome: callOutcomeSchema }),
	/** An earlier execution sent the call and never finished it. */
	Schema.TaggedStruct("Interrupted", { id: Schema.String, error: UserText.schema }),
	/**
	 * The call was recorded and is not sent: this execution sent it already,
	 * or its tool changed since it was sent.
	 */
	Schema.TaggedStruct("NotSent", { id: Schema.String, error: UserText.schema }),
]);
export type CallRecord = typeof callRecordSchema.Type;
