import type { AgentFace } from "@sugabots/contracts";
import { type MotionValue, motion, useTransform } from "motion/react";
import type { RefObject } from "react";
import { Mark, markKey } from "./face-drawing.tsx";
import {
	ARC_EYE_STROKE_WIDTH,
	type FaceMark,
	faceMarks,
	THINKING_DOT_RADIUS,
	viewboxPercentage,
} from "./face-marks.ts";
import type { FaceDrawing } from "./face-rig.ts";
import { restingStyle } from "./layer-motion.ts";

type OpenEyeMark = Exclude<FaceMark, { shape: "stroke" }>;
type ArcEyeMark = Extract<FaceMark, { shape: "stroke" }>;

/**
 * A lively face's eyes, drawn in SVG on the 40-unit face the marks are drawn
 * for: as its mood holds them, closing into smiles, flattening, or shrinking
 * away as the thinking dots grow.
 */
export function LivelyEyes({
	face,
	color,
	drawing,
}: {
	face: AgentFace;
	color: string;
	drawing: FaceDrawing;
}) {
	return (
		<>
			{faceMarks(face).map((mark) => (
				<motion.g key={markKey(mark)} style={{ scale: drawing.eyesShrink }}>
					{
						// An arc is a shut eye already: it only flattens, never blinks or smiles.
						mark.shape === "stroke" ? (
							<ArcEye mark={mark} color={color} flat={drawing.arcsFlat} />
						) : (
							<>
								<OpenEye
									mark={mark}
									color={color}
									height={drawing.eyeHeight}
									smile={drawing.smile}
								/>
								<SmileArc eye={mark} color={color} smile={drawing.smile} />
							</>
						)
					}
				</motion.g>
			))}
		</>
	);
}

/**
 * An open eye, `height` as tall as it is drawn, and fading out as it closes
 * into a smile. However shut, it stays as thick as an arc eye's line, so a
 * sleepy or blinking eye never thins to a hairline.
 */
function OpenEye({
	mark,
	color,
	height,
	smile,
}: {
	mark: OpenEyeMark;
	color: string;
	height: MotionValue<number>;
	smile: MotionValue<number>;
}) {
	const drawnHeight = mark.shape === "circle" ? mark.r * 2 : mark.height;
	const scaleY = useTransform(height, (shown) =>
		Math.max(shown, ARC_EYE_STROKE_WIDTH / drawnHeight),
	);
	const opacity = useTransform(smile, [0, 0.5], [1, 0]);
	return (
		<motion.g style={{ scaleY, opacity }}>
			<Mark mark={mark} color={color} />
		</motion.g>
	);
}

/**
 * The upturned arc an open eye closes into when the bot smiles. It grows up
 * from a flat line as the eye shuts, so the eye seems to close into it, and
 * is hidden while flat.
 */
function SmileArc({
	eye,
	color,
	smile,
}: {
	eye: OpenEyeMark;
	color: string;
	smile: MotionValue<number>;
}) {
	const opacity = useTransform(smile, [0, 0.3], [0, 1]);
	return (
		<motion.path
			d={smileArcPath(eye)}
			fill="none"
			stroke={color}
			strokeWidth={ARC_EYE_STROKE_WIDTH}
			style={{ scaleY: smile, opacity, originY: 1 }}
		/>
	);
}

/** The top half of a ring a little wider than the eye, centred on it. */
function smileArcPath(eye: OpenEyeMark): string {
	const [centreX, centreY, width] =
		eye.shape === "circle"
			? [eye.cx, eye.cy, eye.r * 2]
			: [eye.x + eye.width / 2, eye.y + eye.height / 2, eye.width];
	const radius = width / 2 + 0.6;
	const baseline = centreY + radius * 0.4;
	return `M${centreX - radius} ${baseline}a${radius} ${radius} 0 0 1 ${radius * 2} 0`;
}

/**
 * An arc eye, flattened `flat` of the way into a shut lid. It flattens by
 * bending its arcs, not squashing them, so its line keeps its thickness, and
 * rises as it goes to sit level with open eyes shut as far.
 */
function ArcEye({
	mark,
	color,
	flat,
}: {
	mark: ArcEyeMark;
	color: string;
	flat: MotionValue<number>;
}) {
	const d = useTransform(flat, (flattened) => flattenArcs(mark.d, flattened));
	const y = useTransform(flat, (flattened) => -flattened * ARC_SHUT_RISE);
	return (
		<motion.path d={d} fill="none" stroke={color} strokeWidth={mark.strokeWidth} style={{ y }} />
	);
}

/**
 * How far an arc eye rises as it shuts: its arcs stand on a line about two
 * units below where open eyes are centred.
 */
const ARC_SHUT_RISE = 2;

/**
 * The arc eyes' path with each arc's height cut by `flat`, from 0 (as drawn)
 * to 1 (a straight line). The arcs are the path's relative `a` commands, whose
 * second number is their height.
 */
function flattenArcs(d: string, flat: number): string {
	return d.replace(
		/a([\d.]+) ([\d.]+)/g,
		(_, width: string, height: string) =>
			`a${width} ${Math.max(Number(height) * (1 - flat), 0.01)}`,
	);
}

/*
 * A thinking bot's three dots, across where its eyes were, on the 40-unit
 * face the eyes are drawn for. They're HTML, not SVG, so the browser can raise
 * them on the GPU (see face-rig.ts).
 */
const THINKING_DOT_XS = [14, 20, 26] as const;
const THINKING_DOT_Y = 20;

/** The thinking dots, grown in as the mood turns to thinking; the middle one grows last. */
export function ThinkingDots({ color, drawing }: { color: string; drawing: FaceDrawing }) {
	const [left, middle, right] = drawing.layers.dots;
	return (
		<>
			<ThinkingDot x={THINKING_DOT_XS[0]} color={color} grow={drawing.outerDotsGrow} riser={left} />
			<ThinkingDot
				x={THINKING_DOT_XS[1]}
				color={color}
				grow={drawing.middleDotGrows}
				riser={middle}
			/>
			<ThinkingDot
				x={THINKING_DOT_XS[2]}
				color={color}
				grow={drawing.outerDotsGrow}
				riser={right}
			/>
		</>
	);
}

/** One dot: grown as far as `grow`; `riser` is the layer the browser raises it on. */
function ThinkingDot({
	x,
	color,
	grow,
	riser,
}: {
	x: number;
	color: string;
	grow: MotionValue<number>;
	riser: RefObject<HTMLSpanElement | null>;
}) {
	return (
		<span
			ref={riser}
			className="absolute"
			style={{
				left: `${viewboxPercentage(x - THINKING_DOT_RADIUS)}%`,
				top: `${viewboxPercentage(THINKING_DOT_Y - THINKING_DOT_RADIUS)}%`,
				width: `${viewboxPercentage(THINKING_DOT_RADIUS * 2)}%`,
				height: `${viewboxPercentage(THINKING_DOT_RADIUS * 2)}%`,
				...restingStyle("dot"),
			}}
		>
			<motion.span
				className="block size-full rounded-full"
				style={{ backgroundColor: color, scale: grow }}
			/>
		</span>
	);
}
