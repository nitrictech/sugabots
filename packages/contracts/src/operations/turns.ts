/**
 * The turns operations' contracts, and their entries in the exposure manifest.
 * `index.ts` spreads both, so adding an operation here touches no other file.
 *
 * These are the bot loop's own records of a turn: loading it for a step, the
 * step's model request, its tool calls and their results, asking for
 * approvals, and ending the turn. Each is called by the loop itself for the
 * turn's own principal, and offered to no model and no HTTP client. Each but
 * `turns.endLost` demands that the principal runs the turn: it is the turn's
 * own, still reaches the turn's chat, and the turn hasn't ended.
 */

import { UserText } from "@sugabots/errors";
import { Schema } from "effect";
import { BotCannotReach, ResourceHidden, TurnEnded } from "../errors/proofs.ts";
import { TurnExecutionSuperseded } from "../errors/turns.ts";
import {
	approvalAskedSchema,
	approvalBindingSchema,
	callOutcomeSchema,
	callPlanSchema,
	callRecordSchema,
	decidedStepApprovalSchema,
	offeredToolSchema,
	requestedCallSchema,
	stepCallSchema,
	toolResultOutputSchema,
	turnEnvironmentSchema,
	turnSettingSchema,
} from "../turns.ts";
import { uuidSchema } from "../uuid.ts";
import type { DomainExposure } from "./exposure.ts";
import { OperationContract } from "./operation.ts";

/**
 * How an operation that demands its principal runs the turn refuses: the
 * turn ended, a newer execution of it took over, or the principal lost its
 * chat.
 */
const runsTurnRefusals = [
	TurnEnded,
	TurnExecutionSuperseded,
	ResourceHidden,
	BotCannotReach,
] as const;

/** A turn, by its id and its chat's. */
const aTurn = { chatId: uuidSchema, turnId: uuidSchema };

/** A step of a turn, counted from 0: its `step`th model request. */
const aStep = { ...aTurn, step: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) };

export const turnsContracts = {
	"turns.load": OperationContract.make("turns.load", {
		description:
			"Load the turn for its step: where it is and who it acts for, and what its last step left. A turn that waited for approvals runs on once every one is decided.",
		input: Schema.Struct(aStep),
		output: Schema.Union([
			Schema.TaggedStruct("Begun", {
				setting: turnSettingSchema,
				replyMessageId: uuidSchema,
				/** Whether this step's model request was already made, before a restart. */
				requested: Schema.Boolean,
				/** The last step's tool calls, each with its result once it has one. */
				calls: Schema.Array(stepCallSchema),
				/** The step that made `calls`, which they are recorded under. */
				callsStep: Schema.Int,
				recordedCallIds: Schema.Array(Schema.String),
				/** The last step's calls that waited for approval, and how each was decided. */
				approvals: Schema.Array(decidedStepApprovalSchema),
				/** Whether the step's model request, already made, answered without calling a tool. */
				answered: Schema.Boolean,
				/** Whether a steer reached the turn that no step has read yet. */
				steered: Schema.Boolean,
			}),
			Schema.TaggedStruct("Waiting", { approvals: Schema.Array(Schema.String) }),
			Schema.TaggedStruct("Ended", {}),
		]),
		errors: runsTurnRefusals,
		changes: true,
	}),
	"turns.makeModelRequest": OperationContract.make("turns.makeModelRequest", {
		description:
			"Make the step's model request: send the model the turn's prompt and every earlier step's messages with the tools on offer, send its reply to the chat as it is written, record the request and its cost, and store the step's text and the tool calls it made.",
		input: Schema.Struct({
			...aStep,
			/** The facts the first step's prompt tells the bot about its tools. */
			environment: turnEnvironmentSchema,
			tools: Schema.Array(offeredToolSchema),
			/** Whether this is the last step the turn may take, so the model is told to answer now. */
			lastStep: Schema.Boolean,
		}),
		output: Schema.Union([
			Schema.TaggedStruct("Answered", {}),
			Schema.TaggedStruct("CalledTools", { calls: Schema.Array(requestedCallSchema) }),
			Schema.TaggedStruct("Failed", {
				userMessage: UserText.schema,
				/** Whether running the turn again could help. */
				mayRunAgain: Schema.Boolean,
				/** How long the provider asked to be left, when it said. */
				retryAfterMillis: Schema.optional(Schema.Number),
			}),
		]),
		errors: runsTurnRefusals,
		changes: true,
	}),
	"turns.recordToolCall": OperationContract.make("turns.recordToolCall", {
		description:
			"Record that the turn is sending one of its step's tool calls, before it is sent, and place it in the reply; or say what became of it if an earlier execution recorded it.",
		input: Schema.Struct({
			...aStep,
			toolCallId: Schema.String,
			tool: Schema.String,
			input: Schema.Unknown,
			/** Whether the tool may change something outside Sugabots. */
			writeOrDelete: Schema.Boolean,
			/** The tool the call is bound to: a connector's, as it is configured now, or a built-in one. */
			binding: approvalBindingSchema,
		}),
		output: callRecordSchema,
		errors: runsTurnRefusals,
		changes: true,
	}),
	"turns.planToolCalls": OperationContract.make("turns.planToolCalls", {
		description:
			"Keep how each of the step's tool calls is to be made, sent at once or first put to its approvers, before any of them is sent.",
		input: Schema.Struct({
			...aTurn,
			plans: Schema.Array(Schema.Struct({ toolCallId: Schema.String, plan: callPlanSchema })),
		}),
		output: Schema.Void,
		errors: runsTurnRefusals,
		changes: true,
	}),
	"turns.finishToolCall": OperationContract.make("turns.finishToolCall", {
		description: "Record what one of the turn's tool calls returned, or how it failed.",
		input: Schema.Struct({
			...aTurn,
			/** The recorded call. */
			callId: uuidSchema,
			outcome: callOutcomeSchema,
		}),
		output: Schema.Void,
		errors: runsTurnRefusals,
		changes: true,
	}),
	"turns.startApprovedToolCall": OperationContract.make("turns.startApprovedToolCall", {
		description:
			"Start a tool call an approver allowed, if it is still exactly the call they allowed and its tool still runs as it did; or say what became of it if an earlier execution started it.",
		input: Schema.Struct({
			...aTurn,
			toolCallId: Schema.String,
			tool: Schema.String,
			input: Schema.Unknown,
			binding: approvalBindingSchema,
		}),
		output: Schema.Union([
			...callRecordSchema.members,
			Schema.TaggedStruct("Refused", { reason: Schema.String }),
		]),
		errors: runsTurnRefusals,
		changes: true,
	}),
	"turns.askForApprovals": OperationContract.make("turns.askForApprovals", {
		description:
			"Park the turn until its approvers decide the tool calls of its step that wait for approval.",
		input: Schema.Struct({
			...aStep,
			approvals: Schema.Array(
				Schema.Struct({
					toolCallId: Schema.String,
					...approvalAskedSchema.fields,
					reopenCallId: Schema.optional(uuidSchema),
				}),
			),
		}),
		output: Schema.Union([
			Schema.TaggedStruct("Waiting", { approvals: Schema.Array(Schema.String) }),
			Schema.TaggedStruct("NotWaiting", {}),
		]),
		errors: runsTurnRefusals,
		changes: true,
	}),
	"turns.recordToolResults": OperationContract.make("turns.recordToolResults", {
		description:
			"Record what the model is given back for some of the step's tool calls, for the next step's model request.",
		input: Schema.Struct({
			...aTurn,
			results: Schema.Array(
				Schema.Struct({ toolCallId: Schema.String, output: toolResultOutputSchema }),
			),
		}),
		output: Schema.Void,
		errors: runsTurnRefusals,
		changes: true,
	}),
	"turns.end": OperationContract.make("turns.end", {
		description:
			"End the turn's run: complete its reply, or let an optional turn stay silent, unless a steer reached it that no step has read; fail it, saying whether it runs again; or cancel it.",
		input: Schema.Struct({
			...aTurn,
			ending: Schema.Union([
				Schema.Struct({
					kind: Schema.Literal("answered"),
					/**
					 * The turn may take no more steps: a steer no step has read starts a
					 * turn of its own, rather than give it another.
					 */
					noMoreSteps: Schema.optional(Schema.Boolean),
				}),
				Schema.Struct({
					kind: Schema.Literal("failed"),
					userMessage: UserText.schema,
					mayRunAgain: Schema.Boolean,
					retryAfterMillis: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
				}),
				Schema.Struct({ kind: Schema.Literal("cancelled") }),
			]),
		}),
		output: Schema.Struct({
			willRetry: Schema.Boolean,
			/**
			 * Whether an answer came too soon: a steer reached the turn that no step
			 * has read, so the turn takes another step to read it, rather than end.
			 */
			steered: Schema.Boolean,
		}),
		errors: runsTurnRefusals,
		changes: true,
	}),
	"turns.endLost": OperationContract.make("turns.endLost", {
		description:
			"End the turn as failed after it lost its chat or its step died, or as it was asked to end, unless a newer execution took it over.",
		input: Schema.Struct({
			turnId: uuidSchema,
			/**
			 * How it ends: failed, telling members `userMessage`, or as it was
			 * asked to, telling them why (see `TurnEndRequest`).
			 */
			ending: Schema.Union([
				Schema.TaggedStruct("Failed", { userMessage: UserText.schema }),
				Schema.TaggedStruct("LostReach", { userMessage: UserText.schema }),
				Schema.TaggedStruct("AsRequested", {}),
			]),
		}),
		output: Schema.Void,
		errors: [TurnEnded, TurnExecutionSuperseded, ResourceHidden],
		changes: true,
	}),
} as const;

/** Every one is the loop's own, offered to no model and no HTTP client. */
const loopsOwn = {
	http: {
		kind: "heldBack",
		reason:
			"The bot loop records its own turns; no member or client records a step, a tool call or a turn's end.",
	},
	botLoop: { kind: "calledByLoop" },
} as const;

export const turnsExposure = {
	"turns.load": loopsOwn,
	"turns.makeModelRequest": loopsOwn,
	"turns.recordToolCall": loopsOwn,
	"turns.planToolCalls": loopsOwn,
	"turns.finishToolCall": loopsOwn,
	"turns.startApprovedToolCall": loopsOwn,
	"turns.askForApprovals": loopsOwn,
	"turns.recordToolResults": loopsOwn,
	"turns.end": loopsOwn,
	"turns.endLost": loopsOwn,
} as const satisfies DomainExposure<typeof turnsContracts>;
