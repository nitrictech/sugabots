import { botColors, faceMarks, headShape } from "@sugabots/avatars";
import {
	type AgentColor,
	type AgentFace,
	type AgentShape,
	agentColors,
	agentFaces,
	agentShapes,
	type PodColor,
	podColors,
} from "@sugabots/contracts";
import { useId } from "react";
import { podPalettes } from "@/shell/PodTile.tsx";
import { SettingsControlRow } from "@/ui/settings-page.tsx";

/*
 * Choosing how a bot looks: one of the eight colours, one of the head shapes
 * and one of the eye styles; and a pod's colour, from its own eight. Each is a
 * set of native radio buttons, so arrow keys move the choice. The shapes and
 * eyes are drawn alone on neutral chips, since the face shown above the picker
 * already carries the colour. All of a bot's sets span the full row so their
 * edges line up.
 */

/** LookPicker renders a bot's Colour, Shape and Eyes rows, for a `SettingsGroup` under a preview of the face. */
export function LookPicker({
	color,
	shape,
	face,
	onColorChange,
	onShapeChange,
	onFaceChange,
}: {
	color: AgentColor;
	shape: AgentShape;
	face: AgentFace;
	onColorChange: (color: AgentColor) => void;
	onShapeChange: (shape: AgentShape) => void;
	onFaceChange: (face: AgentFace) => void;
}) {
	return (
		<>
			<SettingsControlRow label="Colour">
				<Swatches
					colors={agentColors}
					swatch={(one) => botColors[one].face}
					value={color}
					onChange={onColorChange}
				/>
			</SettingsControlRow>
			<SettingsControlRow label="Shape">
				<ShapePicker value={shape} onChange={onShapeChange} />
			</SettingsControlRow>
			<SettingsControlRow label="Eyes">
				<EyesPicker value={face} onChange={onFaceChange} />
			</SettingsControlRow>
		</>
	);
}

/** PodColourPicker picks a pod's colour from the pod palette. */
export function PodColourPicker({
	value,
	onChange,
}: {
	value: PodColor;
	onChange: (color: PodColor) => void;
}) {
	return (
		<Swatches
			colors={podColors}
			swatch={(color) => podPalettes[color].swatch}
			value={value}
			onChange={onChange}
		/>
	);
}

/** The ring round the chosen swatch: a gap in the panel's `--list` colour, then the swatch's colour. */
function ring(color: string): string {
	return `0 0 0 3px var(--list), 0 0 0 5px ${color}`;
}

function Swatches<Color extends string>({
	colors,
	swatch,
	value,
	onChange,
}: {
	colors: readonly Color[];
	/** How a colour is drawn as its round swatch. */
	swatch: (color: Color) => string;
	value: Color;
	onChange: (color: Color) => void;
}) {
	const name = useId();
	return (
		// As many 28px columns as fit, spread across the row; on a row too narrow for all eight, the rest wrap into the same columns.
		<fieldset className="m-0 grid flex-1 grid-cols-[repeat(auto-fit,1.75rem)] justify-between gap-1.5 border-0 p-0">
			<legend className="sr-only">Colour</legend>
			{colors.map((color) => (
				<label
					key={color}
					className="size-7 cursor-pointer rounded-full has-focus-visible:outline-2 has-focus-visible:outline-ring has-focus-visible:outline-offset-4"
					style={{
						background: swatch(color),
						boxShadow: value === color ? ring(swatch(color)) : undefined,
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

function ShapePicker({
	value,
	onChange,
}: {
	value: AgentShape;
	onChange: (shape: AgentShape) => void;
}) {
	const name = useId();
	return (
		<fieldset className="m-0 grid flex-1 grid-cols-7 gap-1.5 border-0 p-0">
			<legend className="sr-only">Shape</legend>
			{agentShapes.map((shape) => (
				<label
					key={shape}
					className="grid h-9 cursor-pointer place-items-center rounded-[10px] bg-chip text-soft-foreground transition-colors has-checked:bg-person-avatar has-checked:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring has-focus-visible:outline-offset-4"
				>
					<input
						type="radio"
						name={name}
						value={shape}
						aria-label={shape}
						checked={value === shape}
						onChange={() => onChange(shape)}
						className="sr-only"
					/>
					<ShapeGlyph shape={shape} />
				</label>
			))}
		</fieldset>
	);
}

/** A head's outline without its eyes, in the text colour. */
function ShapeGlyph({ shape }: { shape: AgentShape }) {
	return (
		<svg aria-hidden viewBox="0 0 40 40" width={20} height={20} fill="currentColor">
			{headShape(shape).parts.map((part) =>
				part.kind === "circle" ? (
					<circle key={`${part.cx}-${part.cy}`} cx={part.cx} cy={part.cy} r={part.r} />
				) : (
					<path key={part.d} d={part.d} />
				),
			)}
		</svg>
	);
}

function EyesPicker({
	value,
	onChange,
}: {
	value: AgentFace;
	onChange: (face: AgentFace) => void;
}) {
	const name = useId();
	return (
		<fieldset className="m-0 grid flex-1 grid-cols-5 gap-1.5 border-0 p-0">
			<legend className="sr-only">Eyes</legend>
			{agentFaces.map((face) => (
				<label
					key={face}
					className="grid h-8 cursor-pointer place-items-center rounded-[10px] bg-chip text-soft-foreground transition-colors has-checked:bg-person-avatar has-checked:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring has-focus-visible:outline-offset-4"
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
					<EyesGlyph face={face} />
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
