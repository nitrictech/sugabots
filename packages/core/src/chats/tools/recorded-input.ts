import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "@sugabots/contracts";
import { botLoopTools, operationContracts } from "@sugabots/contracts/operations";
import { Schema } from "effect";

const builtInTools = botLoopTools(operationContracts);

/**
 * The value as JSON keeps it: how a tool call's input is recorded, and the
 * form every comparison with a recorded input uses. The round trip through
 * text drops `undefined` and anything else JSON can't carry.
 */
export function asRecordedJson(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * Whether `input` is the input recorded for a call to `tool`, compared as JSON
 * keeps both, whatever order their keys were written in. For a built-in tool,
 * the stored arguments decoded by its contract now count too (see
 * `decodeRecordedBuiltInInput`).
 */
export function sameRecordedInput(
	tool: string,
	recorded: unknown,
	input: unknown,
	{ builtIn }: { readonly builtIn: boolean },
): boolean {
	const current = asRecordedJson(input);
	if (isDeepStrictEqual(asRecordedJson(recorded), current)) return true;
	return (
		builtIn &&
		isDeepStrictEqual(asRecordedJson(decodeRecordedBuiltInInput(tool, recorded)), current)
	);
}

/**
 * A built-in tool call's stored arguments, decoded by the tool's current
 * contract, so a call recorded before the contract started canonicalising a
 * value (such as lowercasing ids) still compares equal to the same call
 * decoded now. Arguments the contract can't decode, or that carry properties
 * it doesn't name, are returned as stored: they then compare unequal, and the
 * call is refused rather than run with arguments nobody approved.
 */
function decodeRecordedBuiltInInput(tool: string, input: unknown): unknown {
	const offered = builtInTools.find((builtIn) => builtIn.tool === tool);
	if (!offered) return input;
	const decoded = Schema.decodeUnknownResult(operationContracts[offered.operation].input)(input, {
		onExcessProperty: "error",
	});
	return decoded._tag === "Success" ? decoded.success : input;
}
