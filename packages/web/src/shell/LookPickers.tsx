import { botColors, faceMarks } from "@sugabots/avatars";
import {
	type AgentColor,
	type AgentFace,
	agentColors,
	agentFaces,
	type PodColor,
	podColors,
} from "@sugabots/contracts";
import { cn } from "cn";
import { useId } from "react";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { podPalettes } from "@/shell/PodTile.tsx";

/*
 * Choosing how a bot looks: one of the eight colours, and one of the eye
 * styles drawn in that colour; and a pod's colour, from its own eight. Each is
 * a set of native radio buttons, so arrow keys move the choice; the chosen one
 * is ringed in its own colour.
 */

/** The ring round a chosen swatch or face: a gap in the surface's colour, then the chosen colour. */
function ring(color: string, surface: string): string {
	return `0 0 0 3px ${surface}, 0 0 0 5px ${color}`;
}

interface ColourPickerProps<Color extends string> {
	value: Color;
	onChange: (color: Color) => void;
	/** The colour behind the picker, which the gap in the ring shows. */
	surface?: string;
}

export function ColourPicker(props: ColourPickerProps<AgentColor>) {
	return <Swatches colors={agentColors} swatch={(color) => botColors[color].face} {...props} />;
}

export function PodColourPicker(props: ColourPickerProps<PodColor>) {
	return <Swatches colors={podColors} swatch={(color) => podPalettes[color].swatch} {...props} />;
}

function Swatches<Color extends string>({
	colors,
	swatch,
	value,
	onChange,
	surface = "var(--list)",
}: ColourPickerProps<Color> & {
	colors: readonly Color[];
	/** How a colour is drawn as its round swatch. */
	swatch: (color: Color) => string;
}) {
	const name = useId();
	return (
		// An 8px gap, the widest that fits eight swatches beside a field's label in a settings page.
		<fieldset className="m-0 flex flex-1 flex-wrap gap-2 border-0 p-0">
			<legend className="sr-only">Colour</legend>
			{colors.map((color) => (
				<label
					key={color}
					className="size-7 cursor-pointer rounded-full has-focus-visible:outline-2 has-focus-visible:outline-ring has-focus-visible:outline-offset-4"
					style={{
						background: swatch(color),
						boxShadow: value === color ? ring(swatch(color), surface) : undefined,
					}}
				>
					<input
						type="radio"
						name={name}
						value={color}
						aria-label={color}
						checked={value === color}
						onChange={() => onChange(color)}
						className="sr-only"
					/>
				</label>
			))}
		</fieldset>
	);
}

export function EyesPicker({
	color,
	value,
	onChange,
	surface = "var(--list)",
	size = 40,
	variant = "faces",
}: {
	/** The colour the faces are drawn in. */
	color: AgentColor;
	value: AgentFace;
	onChange: (face: AgentFace) => void;
	surface?: string;
	size?: number;
	/**
	 * `faces` draws each style on the bot's own face; `chips`, the eyes alone on
	 * a neutral chip, as a form does where the face above already shows the colour.
	 */
	variant?: "faces" | "chips";
}) {
	const name = useId();
	return (
		<fieldset className="m-0 flex flex-1 flex-wrap gap-1.5 border-0 p-0">
			<legend className="sr-only">Eyes</legend>
			{agentFaces.map((face) => (
				<label
					key={face}
					className={cn(
						"cursor-pointer has-focus-visible:outline-2 has-focus-visible:outline-ring has-focus-visible:outline-offset-4",
						variant === "chips"
							? "grid h-8 w-11 place-items-center rounded-[10px] bg-chip text-soft-foreground transition-colors has-checked:bg-person-avatar has-checked:text-foreground"
							: "rounded-full",
					)}
					style={
						variant === "faces" && value === face
							? { boxShadow: ring(botColors[color].face, surface) }
							: undefined
					}
				>
					<input
						type="radio"
						name={name}
						value={face}
						aria-label={face}
						checked={value === face}
						onChange={() => onChange(face)}
						className="sr-only"
					/>
					{variant === "chips" ? (
						<EyesGlyph face={face} />
					) : (
						<AgentAvatar color={color} face={face} size={size} />
					)}
				</label>
			))}
		</fieldset>
	);
}

/** A face's eyes without the face, in the text colour, cropped to the band they sit in. */
function EyesGlyph({ face }: { face: AgentFace }) {
	return (
		<svg aria-hidden viewBox="6 12 28 16" width={34} height={19} className="text-current">
			{faceMarks(face).map((mark, index) =>
				mark.shape === "circle" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: a face's marks are fixed and never reorder.
					<circle key={index} cx={mark.cx} cy={mark.cy} r={mark.r} fill="currentColor" />
				) : mark.shape === "rect" ? (
					<rect
						// biome-ignore lint/suspicious/noArrayIndexKey: as above.
						key={index}
						x={mark.x}
						y={mark.y}
						width={mark.width}
						height={mark.height}
						rx={mark.rx}
						fill="currentColor"
					/>
				) : (
					<path
						// biome-ignore lint/suspicious/noArrayIndexKey: as above.
						key={index}
						d={mark.d}
						fill="none"
						stroke="currentColor"
						strokeWidth={mark.strokeWidth}
						strokeLinecap="round"
					/>
				),
			)}
		</svg>
	);
}
