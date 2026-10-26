import type { AgentColor, AgentFace, AgentShape } from "@sugabots/contracts";

/** How a bot looks. A look without a shape is a circle, as every bot was before shapes. */
export interface BotLook {
	color: AgentColor;
	face: AgentFace;
	shape?: AgentShape;
}
