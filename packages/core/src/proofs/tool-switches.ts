import type { BuiltInToolKey } from "@sugabots/contracts";
import { ApprovalRefused } from "@sugabots/contracts/errors/proofs";
import { AUTOMATIONS_TOOL_KEY } from "@sugabots/contracts/operations/automations";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../database/database.ts";
import { bot } from "../database/schema.ts";
import type { ApprovedOperation } from "./approved.ts";

/**
 * The built-in tool whose switch on a bot's settings turns each operation's
 * tool off. The automations switch covers every tool a bot reads and changes
 * its own automations with.
 */
const switchedBy = {
	"files.listWritten": "file_list",
	"files.readWritten": "file_read",
	"files.write": "file_write",
	"files.edit": "file_edit",
	"web.fetch": "web_fetch",
	"web.search": "web_search",
	"automations.list": AUTOMATIONS_TOOL_KEY,
	"automations.listInChat": AUTOMATIONS_TOOL_KEY,
	"automations.createWithRoutine": AUTOMATIONS_TOOL_KEY,
	"automations.updateInChat": AUTOMATIONS_TOOL_KEY,
} as const satisfies Partial<Record<ApprovedOperation, BuiltInToolKey>>;

/** The built-in tool whose switch turns the operation's tool off, if one does. */
export function toolSwitchFor(operation: ApprovedOperation): BuiltInToolKey | undefined {
	const switches: Partial<Record<ApprovedOperation, BuiltInToolKey>> = switchedBy;
	return switches[operation];
}

/** Whether the bot `botId` has the built-in tool `tool` on now: not switched off, and the bot not gone. */
export const toolIsOn = (db: Executor, botId: string, tool: BuiltInToolKey) =>
	Effect.map(
		db.select({ disabledTools: bot.disabledTools }).from(bot).where(eq(bot.id, botId)).limit(1),
		([row]) => row !== undefined && !row.disabledTools.includes(tool),
	);

/** The refusal of a call whose built-in tool `tool` is switched off. */
export const toolSwitchedOff = (tool: BuiltInToolKey) =>
	new ApprovalRefused(tool === AUTOMATIONS_TOOL_KEY ? { reason: "automationsOff" } : {});
