/**
 * What the bot loop and core hand each other about a turn, through
 * `RunningTurn`. None of it crosses a wire: the loop runs in the server's
 * process. A call's plan is stored, so it keeps a schema to read it back by.
 */

import type { BotColor, BotVisibility } from "@sugabots/contracts/bots";
import type { ChatKind } from "@sugabots/contracts/messages";
import type { UserText } from "@sugabots/errors";
import { Schema } from "effect";
import type { TurnReason } from "../sql.ts";

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

/**
 * What an approved call must still match when it runs, beyond its tool and
 * input: for a connector's tool, the connector configured as it was when
 * the member allowed it. A built-in tool is the same tool wherever it runs.
 */
const approvalBindingSchema = Schema.Union([
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

/**
 * What a call waits for approval of: the tool, the input it gives it, what
 * that must still match when it runs, and whether it may change something.
 */
const approvalAskedSchema = Schema.Struct({
	tool: Schema.String,
	input: Schema.Unknown,
	binding: approvalBindingSchema,
	writeOrDelete: Schema.Boolean,
	reason: Schema.optional(Schema.String),
	computerProjectId: Schema.optional(Schema.String),
	resolvedTargets: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
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
export interface StepCall {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: unknown;
	/** How the call is to be made, once the step decided it. */
	readonly plan?: CallPlan;
	readonly result?: ToolResultOutput;
}

/** A call of the last step that waits for approval, and what it must still match to run. */
export interface StepApproval {
	readonly approvalId: string;
	readonly toolCallId: string;
	readonly tool: string;
	readonly binding: ApprovalBinding;
}

/** A call of the last step that waited for approval, with how its approver decided it so far. */
export interface DecidedStepApproval extends StepApproval {
	/** `withdrawn` when its asker steered the turn before anyone decided it. */
	readonly decision: "pending" | "allowed" | "denied" | "withdrawn";
}

/**
 * A tool the step offers the model, as its model request sends it: its
 * name, what it does, and the JSON Schema of its input.
 */
export interface OfferedTool {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema: { readonly [key: string]: unknown };
}

/**
 * The facts about one turn's tools that the bot is told, gathered when its
 * first step's prompt is made: what it has, where to find the rest, and its
 * computer.
 */
export interface TurnEnvironment {
	/** The built-in tools on offer this turn, by key, so the bot is told it has them. */
	readonly builtInTools: ReadonlyArray<string>;
	/** How to find the tools in the catalog, and which are there. */
	readonly toolCatalog: string | undefined;
	readonly computer: string | undefined;
}

/** A tool call a step's model request made. `invalid` says what was wrong with its input, if anything. */
export interface RequestedCall {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: unknown;
	readonly invalid?: string;
}

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
type CallOutcome = { readonly output: unknown } | { readonly error: UserText };

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
export type CallRecord =
	/** Send the call now, recorded as `id`. */
	| { readonly _tag: "Send"; readonly id: string }
	/** An earlier execution finished the call. */
	| { readonly _tag: "Finished"; readonly id: string; readonly outcome: CallOutcome }
	/** An earlier execution sent the call and never finished it. */
	| { readonly _tag: "Interrupted"; readonly id: string; readonly error: UserText }
	/**
	 * The call was recorded and is not sent: this execution sent it already,
	 * or its tool changed since it was sent.
	 */
	| { readonly _tag: "NotSent"; readonly id: string; readonly error: UserText };
