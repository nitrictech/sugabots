import type { AgentFace } from "@sugabots/contracts";
import { cn } from "cn";
import type { ComponentProps } from "react";
import { type BotColor, botColors } from "./bot-colors.ts";
import { FACE_VIEWBOX_SIZE, type FaceMark, faceMarks } from "./face-marks.ts";

/** How a bot looks: the pair is its identity, so keep them together. */
export interface BotLook {
	color: BotColor;
	face: AgentFace;
}

type BotFaceProps = BotLook & Omit<ComponentProps<"svg">, "color">;

/**
 * A bot's face: a coloured disc with its eyes. It has no intrinsic size, so
 * size it with `className` (e.g. `size-8`).
 */
export function BotFace({ color, face, className, ...props }: BotFaceProps) {
	const colors = botColors[color];
	const radius = FACE_VIEWBOX_SIZE / 2;
	return (
		<svg
			viewBox={`0 0 ${FACE_VIEWBOX_SIZE} ${FACE_VIEWBOX_SIZE}`}
			aria-hidden
			className={cn("shrink-0", className)}
			{...props}
		>
			<circle cx={radius} cy={radius} r={radius} className={colors.faceFill} />
			{faceMarks(face).map((mark) => (
				<Mark key={markKey(mark)} mark={mark} fill={colors.eyesFill} stroke={colors.eyesStroke} />
			))}
		</svg>
	);
}

function Mark({ mark, fill, stroke }: { mark: FaceMark; fill: string; stroke: string }) {
	switch (mark.shape) {
		case "circle":
			return <circle cx={mark.cx} cy={mark.cy} r={mark.r} className={fill} />;
		case "rect":
			return (
				<rect
					x={mark.x}
					y={mark.y}
					width={mark.width}
					height={mark.height}
					rx={mark.rx}
					className={fill}
				/>
			);
		case "stroke":
			return (
				<path
					d={mark.d}
					fill="none"
					strokeWidth={mark.strokeWidth}
					strokeLinecap="round"
					className={stroke}
				/>
			);
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
