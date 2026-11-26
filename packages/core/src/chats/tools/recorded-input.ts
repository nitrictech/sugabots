import { botLoopTools, operationContracts } from "@sugabots/contracts/operations";
import { Schema } from "effect";

const builtInTools = botLoopTools(operationContracts);

/**
 * A built-in tool call's stored arguments, decoded by the tool's current
 * contract, so a call recorded before the contract started canonicalising a
 * value (such as lowercasing ids) still compares equal to the same call
 * decoded now. Arguments the contract can't decode, or that carry properties
 * it doesn't name, are returned as stored: they then compare unequal, and the
 * call is refused rather than run with arguments nobody approved.
 */
export function decodeRecordedBuiltInInput(tool: string, input: unknown): unknown {
	const offered = builtInTools.find((builtIn) => builtIn.tool === tool);
	if (!offered) return input;
	const decoded = Schema.decodeUnknownResult(operationContracts[offered.operation].input)(input, {
		onExcessProperty: "error",
	});
	return decoded._tag === "Success" ? decoded.success : input;
}
