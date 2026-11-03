import type { FaceMark } from "./face-marks.ts";
import type { HeadPart } from "./head-shapes.ts";

/** One piece of a head, filled by its group. A ringed piece keeps its stroke's pixel width at any size. */
export function Part({ part, ringed = false }: { part: HeadPart; ringed?: boolean }) {
	const effect = ringed ? "non-scaling-stroke" : undefined;
	return part.kind === "circle" ? (
		<circle cx={part.cx} cy={part.cy} r={part.r} vectorEffect={effect} />
	) : (
		<path d={part.d} vectorEffect={effect} />
	);
}

export function partKey(part: HeadPart): string {
	return part.kind === "circle" ? `circle-${part.cx}-${part.cy}` : part.d;
}

export function Mark({ mark, color }: { mark: FaceMark; color: string }) {
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

export function markKey(mark: FaceMark): string {
	switch (mark.shape) {
		case "circle":
			return `circle-${mark.cx}`;
		case "rect":
			return `rect-${mark.x}`;
		case "stroke":
			return mark.d;
	}
}
