import { botPalettes, faceMarks, headShape } from "@sugabots/avatars";
import {
	type BotColor,
	type BotEyes,
	type BotShape,
	botColors,
	botEyes,
	botShapes,
	type ProjectColor,
	projectColors,
} from "@sugabots/contracts";
import { cn } from "cn";
import { type CSSProperties, useId } from "react";
import { projectPalettes } from "@/lib/project-looks.ts";
import { SettingsControlRow } from "@/ui/settings-page.tsx";

/*
 * Choosing how a bot looks: one of the bot colours, one of the head shapes
 * and one of the eye styles; and a project's colour, from its own eight. Each is a
 * set of native radio buttons, so arrow keys move the choice. The shapes and
 * eyes are drawn alone on neutral chips, since the face shown above the picker
 * already carries the colour. All of a bot's sets span the full row so their
 * edges line up.
 */

/** AvatarPicker renders a bot's Colour, Shape and Eyes rows, for a `SettingsGroup` under a preview of the face. */
export function AvatarPicker({
	color,
	shape,
	eyes,
	onColorChange,
	onShapeChange,
	onEyesChange,
}: {
	color: BotColor;
	shape: BotShape;
	eyes: BotEyes;
	onColorChange: (color: BotColor) => void;
	onShapeChange: (shape: BotShape) => void;
	onEyesChange: (eyes: BotEyes) => void;
}) {
	return (
		<>
			<SettingsControlRow label="Colour" stackOnPhone>
				<BotColourPicker value={color} onChange={onColorChange} />
			</SettingsControlRow>
			<SettingsControlRow label="Shape" stackOnPhone>
				<ShapePicker value={shape} onChange={onShapeChange} />
			</SettingsControlRow>
			<SettingsControlRow label="Eyes" stackOnPhone>
				<EyesPicker value={eyes} onChange={onEyesChange} />
			</SettingsControlRow>
		</>
	);
}

/** BotColourPicker picks a bot's colour from the bot palette, in rows of eight. */
export function BotColourPicker({
	value,
	onChange,
}: {
	value: BotColor;
	onChange: (color: BotColor) => void;
}) {
	return (
		<Swatches
			colors={botColors}
			swatch={(color) => botPalettes[color].face}
			value={value}
			onChange={onChange}
			columns={8}
		/>
	);
}

/** ProjectColourPicker picks a project's colour from the project palette. */
export function ProjectColourPicker({
	value,
	onChange,
}: {
	value: ProjectColor;
	onChange: (color: ProjectColor) => void;
}) {
	return (
		<Swatches
			colors={projectColors}
			swatch={(color) => projectPalettes[color].swatch}
			value={value}
			onChange={onChange}
		/>
	);
}

function Swatches<Color extends string>({
	colors,
	swatch,
	value,
	onChange,
	columns,
}: {
	colors: readonly Color[];
	/** How a colour is drawn as its round swatch. */
	swatch: (color: Color) => string;
	value: Color;
	onChange: (color: Color) => void;
	/**
	 * How many swatches go in each row: up to 32px each, shrinking to fit a
	 * narrow row, with the same gap down as across. Without it, as many 28px
	 * swatches as fit are spread across the row; on a row too narrow for them
	 * all, the rest wrap into the same columns.
	 */
	columns?: number;
}) {
	const name = useId();
	return (
		// `min-w-0`: a fieldset is otherwise as wide as its swatches, and would push what is beside it aside.
		<fieldset
			className={cn(
				"m-0 grid min-w-0 flex-1 border-0 p-0",
				columns ? "gap-2.5" : "grid-cols-swatches justify-between gap-1.5",
			)}
			style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 2rem))` } : undefined}
		>
			<legend className="sr-only">Colour</legend>
			{colors.map((color) => (
				<label
					key={color}
					// The chosen one is ringed by an outline set out from it, so the gap shows whatever is behind.
					className={cn(
						"aspect-square cursor-pointer rounded-full bg-(--swatch) has-focus-visible:outline-2 has-focus-visible:outline-ring has-focus-visible:outline-offset-4",
						columns ? "w-full" : "size-7",
						value === color && "outline-2 outline-(--swatch) outline-offset-2",
					)}
					style={{ "--swatch": swatch(color) } as CSSProperties}
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
	value: BotShape;
	onChange: (shape: BotShape) => void;
}) {
	const name = useId();
	return (
		<fieldset className="m-0 grid flex-1 grid-cols-7 gap-1.5 border-0 p-0">
			<legend className="sr-only">Shape</legend>
			{botShapes.map((shape) => (
				<label
					key={shape}
					className="grid h-9 cursor-pointer place-items-center rounded-lg bg-chip max-sm:aspect-square max-sm:h-auto text-soft-foreground transition-colors has-checked:bg-member-avatar has-checked:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring has-focus-visible:outline-offset-4"
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

/** A head shape alone, without eyes, in the current colour, `size` pixels square. */
export function ShapeGlyph({ shape, size = 20 }: { shape: BotShape; size?: number }) {
	return (
		<svg aria-hidden viewBox="0 0 40 40" width={size} height={size} fill="currentColor">
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

function EyesPicker({ value, onChange }: { value: BotEyes; onChange: (eyes: BotEyes) => void }) {
	const name = useId();
	return (
		<fieldset className="m-0 grid flex-1 grid-cols-5 gap-1.5 border-0 p-0">
			<legend className="sr-only">Eyes</legend>
			{botEyes.map((eyes) => (
				<label
					key={eyes}
					className="grid h-8 cursor-pointer place-items-center rounded-lg bg-chip max-sm:h-11 text-soft-foreground transition-colors has-checked:bg-member-avatar has-checked:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring has-focus-visible:outline-offset-4"
				>
					<input
						type="radio"
						name={name}
						value={eyes}
						aria-label={eyes}
						checked={value === eyes}
						onChange={() => onChange(eyes)}
						className="sr-only"
					/>
					<EyesGlyph eyes={eyes} />
				</label>
			))}
		</fieldset>
	);
}

/** A pair of eyes alone, without a head, in the current colour, `width` pixels across. */
export function EyesGlyph({ eyes, width = 34 }: { eyes: BotEyes; width?: number }) {
	return (
		<svg
			aria-hidden
			viewBox="6 12 28 16"
			width={width}
			height={(width * 16) / 28}
			className="text-current"
		>
			{faceMarks(eyes).map((mark, index) =>
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
