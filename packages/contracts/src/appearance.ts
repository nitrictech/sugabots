import { type AgentColor, agentColors } from "./agents.ts";

/** A stable colour for something named `text`, so the same name always gets the same colour. */
export function colorFromText(text: string): AgentColor {
	let hash = 0;
	for (const character of text) {
		hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 997;
	}
	return agentColors[hash % agentColors.length] ?? "green";
}
