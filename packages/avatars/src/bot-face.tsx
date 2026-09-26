import type { AgentColor, AgentFace } from "@sugabots/contracts";
import { cn } from "cn";
import type { ComponentProps } from "react";
import { botColors } from "./bot-colors.ts";
import { FACE_VIEWBOX_SIZE, type FaceMark, faceMarks } from "./face-marks.ts";

/** How a bot looks. */
export interface BotLook {
	color: AgentColor;
	face: AgentFace;
}

type BotFaceProps = BotLook & Omit<ComponentProps<"svg">, "color">;

/**
 * A bot's face: a coloured disc with its eyes. It has no intrinsic size, so
 * size it with `className` (e.g. `size-8`) or `width` and `height`.
 */
export function BotFace({ color, face, className, ...props }: BotFaceProps) {
	const { face: faceColor, eyes } = botColors[color];
	const radius = FACE_VIEWBOX_SIZE / 2;
	return (
		<svg
			viewBox={`0 0 ${FACE_VIEWBOX_SIZE} ${FACE_VIEWBOX_SIZE}`}
			aria-hidden
			className={cn("shrink-0", className)}
			{...props}
		>
			<circle cx={radius} cy={radius} r={radius} fill={faceColor} />
			{faceMarks(face).map((mark) => (
				<Mark key={markKey(mark)} mark={mark} color={eyes} />
			))}
		</svg>
	);
}

function Mark({ mark, color }: { mark: FaceMark; color: string }) {
	switch (mark.shape) {
		case "circle":
			return <circle cx={mark.cx} cy={mark.cy} r={mark.r} fill={color} />;
		case "rect":
			return (
				<rect
					x={mark.x}
					y={mark.y}
					width={mark.width}
					height={mark.height}
					rx={mark.rx}
					fill={color}
				/>
			);
		case "stroke":
			return <path d={mark.d} fill="none" stroke={color} strokeWidth={mark.strokeWidth} />;
	}
}

function markKey(mark: FaceMark): string {
	switch (mark.shape) {
		case "circle":
			return `circle-${mark.cx}`;
		case "rect":
			return `rect-${mark.x}`;
		case "stroke":
			return mark.d;
	}
}
