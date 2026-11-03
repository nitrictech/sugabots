import type { AgentColor, AgentFace, AgentShape } from "@sugabots/contracts";
import { cn } from "cn";
import type { ComponentProps } from "react";
import { botColors } from "./bot-colors.ts";
import { Mark, markKey, Part, partKey } from "./face-drawing.tsx";
import { FACE_VIEWBOX_SIZE, faceMarks } from "./face-marks.ts";
import { headShape } from "./head-shapes.ts";

/** How a bot looks. A look without a shape is a circle, as every bot was before shapes. */
export interface BotLook {
	color: AgentColor;
	face: AgentFace;
	shape?: AgentShape;
}

type BotFaceProps = BotLook &
	Omit<ComponentProps<"svg">, "color"> & {
		/**
		 * A colour drawn round the head's edge, following its shape: what parts
		 * faces that overlap in a stack. Its width is in pixels, whatever the size.
		 */
		ring?: { color: string; width: number };
	};

/**
 * A bot's face: its head in the bot's colour, with its eyes. It has no
 * intrinsic size, so size it with `className` (e.g. `size-8`) or `width` and
 * `height`.
 */
export function BotFace({
	color,
	face,
	shape = "circle",
	ring,
	className,
	...props
}: BotFaceProps) {
	const { face: faceColor, eyes } = botColors[color];
	const head = headShape(shape);
	const { x, y, scale } = head.eyes;
	return (
		<svg
			viewBox={`0 0 ${FACE_VIEWBOX_SIZE} ${FACE_VIEWBOX_SIZE}`}
			aria-hidden
			// A ring is drawn outside the head, past the viewbox's edge.
			overflow={ring ? "visible" : undefined}
			className={cn("shrink-0", className)}
			{...props}
		>
			{ring && (
				// A style rather than attributes, so the colour may be a CSS variable.
				<g
					style={{ fill: ring.color, stroke: ring.color }}
					strokeWidth={ring.width * 2}
					strokeLinejoin="round"
				>
					{head.parts.map((part) => (
						<Part key={partKey(part)} part={part} ringed />
					))}
				</g>
			)}
			<g fill={faceColor}>
				{head.parts.map((part) => (
					<Part key={partKey(part)} part={part} />
				))}
			</g>
			<g transform={`translate(${x} ${y}) scale(${scale}) translate(${-CENTRE} ${-CENTRE})`}>
				{faceMarks(face).map((mark) => (
					<Mark key={markKey(mark)} mark={mark} color={eyes} />
				))}
			</g>
		</svg>
	);
}

const CENTRE = FACE_VIEWBOX_SIZE / 2;
