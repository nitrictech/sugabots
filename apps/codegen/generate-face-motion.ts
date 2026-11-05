/**
 * Writes `Sugabots/Design/FaceMotion.generated.swift` from how
 * `@sugabots/avatars` draws bots' faces and brings them to life, and the mood
 * loops the web app gives them, so the app's faces are drawn and move by the
 * same numbers and paths as the web's. What each act does with them is copied
 * by hand, in `FaceRig.swift`.
 */
import * as marks from "../../packages/avatars/src/face-marks.ts";
import * as rig from "../../packages/avatars/src/face-rig.ts";
import { pacingByLiveliness } from "../../packages/avatars/src/group-pacing.ts";
import * as hop from "../../packages/avatars/src/hop.ts";
import * as layers from "../../packages/avatars/src/layer-motion.ts";
import { defaultLiveliness, livelinessLevels } from "../../packages/avatars/src/liveliness.ts";
import * as moodLoop from "../../packages/avatars/src/mood-loop.ts";
import * as moods from "../../packages/avatars/src/moods.ts";
import type { Span } from "../../packages/avatars/src/random.ts";
import * as screenMoods from "../../packages/avatars/src/screen-moods.ts";
import * as watching from "../../packages/avatars/src/watching.ts";
import type { GeneratedFiles } from "./generated-files.ts";

/** A Swift value: its type, as Swift can't infer it from a whole number, and its code. */
interface SwiftValue {
	type: string;
	code: string;
}

const numbers = (values: readonly number[]) => `[${values.join(", ")}]`;

const double = (value: number): SwiftValue => ({ type: "Double", code: `${value}` });
const doubles = (values: readonly number[]): SwiftValue => ({
	type: "[Double]",
	code: numbers(values),
});
const closedRange = ([least, most]: readonly [number, number]): SwiftValue => ({
	type: "ClosedRange<Double>",
	code: `${least} ... ${most}`,
});
const span = ({ least, most }: Span) => `Span(least: ${least}, most: ${most})`;
const spring = ({
	stiffness,
	damping,
	restDelta,
	restSpeed,
}: {
	stiffness: number;
	damping: number;
	restDelta?: number;
	restSpeed?: number;
}): SwiftValue => ({
	type: "SpringTuning",
	code: `SpringTuning(stiffness: ${stiffness}, damping: ${damping}${restDelta === undefined ? "" : `, restDelta: ${restDelta}`}${restSpeed === undefined ? "" : `, restSpeed: ${restSpeed}`})`,
});
/** A named easing as Swift's `Easing`; the app knows only the names the faces use. */
function easing(ease: unknown): string {
	if (typeof ease !== "string")
		throw new Error(`The app's faces take named easings only, not ${String(ease)}`);
	return `.${ease}`;
}
const easings = (eases: readonly unknown[]) => `[${eases.map(easing).join(", ")}]`;
const keyframesCode = ({ frames, times, ease, seconds }: layers.KeyframesPath) =>
	`Keyframes(frames: [${frames.map(numbers).join(", ")}], times: ${numbers(times)}, ease: ${easings(ease)}, seconds: ${seconds})`;
const keyframes = (path: layers.KeyframesPath): SwiftValue => ({
	type: "Keyframes",
	code: keyframesCode(path),
});
/** One value's keyframes as Swift's `Keyframes`, each frame a single value. */
const valueKeyframes = ({ frames, times, ease, seconds }: rig.ValueKeyframes): SwiftValue =>
	keyframes({
		kind: "keyframes",
		frames: frames.map((frame) => [frame]),
		times,
		ease,
		seconds,
	});
const path = (one: layers.Path) =>
	one.kind === "keyframes"
		? `.keyframes(${keyframesCode(one)})`
		: `.spring(to: ${numbers(one.to)}, ${spring(one).code})`;

function moodLiteral(mood: moods.BotMood): string {
	const { look, gaze, watches, act } = moods.moods[mood];
	const parts = [
		`look: MoodLook(eyesOpen: ${look.eyesOpen}, smile: ${look.smile}, arcsFlat: ${look.arcsFlat}, dots: ${look.dots}, eyesLift: ${look.eyesLift}, headDrop: ${look.headDrop}, headLean: ${look.headLean})`,
		`gaze: Gaze(x: ${gaze?.x ?? 0}, y: ${gaze?.y ?? 0})`,
		`watches: ${watches === true}`,
		`act: ${act ? `MoodAct(pause: ${span(act.pause)}, firstPause: ${span(act.firstPause ?? act.pause)})` : "nil"}`,
	];
	return `Mood(${parts.join(", ")})`;
}

function moodLoopValue(spells: moodLoop.MoodLoop): SwiftValue {
	const literals = spells.map(
		(spell) =>
			`MoodSpell(mood: .${spell.mood}, weight: ${spell.weight}, seconds: ${span(spell.seconds)})`,
	);
	return {
		type: "MoodLoop",
		code: `MoodLoop(rest: ${literals[0]}, others: [${literals.slice(1).join(", ")}])`,
	};
}

/**
 * A Swift constant `name` holding `value`, documented as the constant `source`
 * in the avatars' `file`, with what `note` adds, such as a change of unit.
 */
function constant(
	name: string,
	{ source, file, note }: { source: string; file: string; note?: string },
	value: SwiftValue,
): string[] {
	const doc = `As \`${source}\` in \`${file}\`${note ? `, ${note}` : ""}.`;
	return [`\t/// ${doc}`, `\tstatic let ${name}: ${value.type} = ${value.code}`];
}

const fromRig = (source: keyof typeof rig & string, note?: string) => ({
	source,
	file: "face-rig.ts",
	note,
});
const fromLayers = (source: keyof typeof layers & string, note?: string) => ({
	source,
	file: "layer-motion.ts",
	note,
});
const fromMarks = (source: keyof typeof marks & string) => ({ source, file: "face-marks.ts" });
const fromMoods = (source: keyof typeof moods & string) => ({ source, file: "moods.ts" });

const layerNames = Object.keys(layers.layerKinds) as layers.LayerName[];

export function generate(): GeneratedFiles {
	const lines = [
		"// Generated by apps/codegen/generate-face-motion.ts from @sugabots/avatars. Do not edit.",
		"",
		"/// How much bot faces move, as someone has chosen, as `Liveliness`.",
		"enum Liveliness: String, CaseIterable {",
		...livelinessLevels.map((level) => `\tcase ${level}`),
		"",
		"\t/// What someone gets before they choose, as `defaultLiveliness`.",
		`\tstatic let chosenByDefault = Liveliness.${defaultLiveliness}`,
		"",
		"\t/// How the faces in a group take turns to move, as `pacingByLiveliness`; none move when off.",
		"\tvar groupPacing: GroupPacing? {",
		"\t\tswitch self {",
		...livelinessLevels.map((level) => {
			if (level === "off") return "\t\tcase .off: nil";
			const pacing = pacingByLiveliness[level];
			return `\t\tcase .${level}: GroupPacing(movingAtOnce: ${pacing.movingAtOnce}, gapSeconds: ${span(pacing.gapSeconds)}, turnSeconds: ${span(pacing.turnSeconds)})`;
		}),
		"\t\t}",
		"\t}",
		"}",
		"",
		"/// The moods a bot can be in, as `botMoods`.",
		"enum BotMood: String, CaseIterable {",
		...moods.botMoods.map((mood) => `\tcase ${mood}`),
		"",
		"\t/// How the mood holds the face and how often it acts, as `moods`.",
		"\tvar mood: Mood {",
		"\t\tswitch self {",
		...moods.botMoods.map((mood) => `\t\tcase .${mood}: ${moodLiteral(mood)}`),
		"\t\t}",
		"\t}",
		"}",
		"",
		"/// The layers a face's parts move on, as `layerKinds` in `layer-motion.ts`.",
		"/// Translations are percentages of the face; turns are in degrees.",
		"enum FaceLayer: String, CaseIterable {",
		...layerNames.map((name) => `\tcase ${name}`),
		"",
		"\t/// Where the layer rests, as its kind's `rest`.",
		"\tvar rest: [Double] {",
		"\t\tswitch self {",
		...layerNames.map((name) => `\t\tcase .${name}: ${numbers(layers.layerKinds[name].rest)}`),
		"\t\t}",
		"\t}",
		"}",
		"",
		"/// How a face is drawn, in the square of `viewboxSize` units it is drawn in.",
		"enum FaceGeometry {",
		...constant("viewboxSize", fromMarks("FACE_VIEWBOX_SIZE"), double(marks.FACE_VIEWBOX_SIZE)),
		...constant(
			"arcEyeStrokeWidth",
			fromMarks("ARC_EYE_STROKE_WIDTH"),
			double(marks.ARC_EYE_STROKE_WIDTH),
		),
		...constant("arcShutRise", fromMarks("ARC_SHUT_RISE"), double(marks.ARC_SHUT_RISE)),
		...constant(
			"flattestArcHeight",
			fromMarks("FLATTEST_ARC_HEIGHT"),
			double(marks.FLATTEST_ARC_HEIGHT),
		),
		...constant(
			"smileArcWidening",
			fromMarks("SMILE_ARC_WIDENING"),
			double(marks.SMILE_ARC_WIDENING),
		),
		...constant(
			"smileArcBaselineShare",
			fromMarks("SMILE_ARC_BASELINE_SHARE"),
			double(marks.SMILE_ARC_BASELINE_SHARE),
		),
		...constant("openEyeFades", fromMarks("OPEN_EYE_FADES"), closedRange(marks.OPEN_EYE_FADES)),
		...constant("smileArcShows", fromMarks("SMILE_ARC_SHOWS"), closedRange(marks.SMILE_ARC_SHOWS)),
		...constant(
			"thinkingDotRadius",
			fromMarks("THINKING_DOT_RADIUS"),
			double(marks.THINKING_DOT_RADIUS),
		),
		...constant("thinkingDotXs", fromMarks("THINKING_DOT_XS"), doubles(marks.THINKING_DOT_XS)),
		...constant("thinkingDotY", fromMarks("THINKING_DOT_Y"), double(marks.THINKING_DOT_Y)),
		"}",
		"",
		"/// The numbers and paths a face moves by. Distances are in the face's",
		"/// viewbox units unless they say they're percentages of the face.",
		"enum FaceMotion {",
		...constant("tickSeconds", fromLayers("TICK_SECONDS"), double(layers.TICK_SECONDS)),
		...constant(
			"springSettleStepMilliseconds",
			fromLayers("SPRING_SETTLE_STEP_MILLISECONDS"),
			double(layers.SPRING_SETTLE_STEP_MILLISECONDS),
		),
		...constant(
			"longestSpringMilliseconds",
			fromLayers("LONGEST_SPRING_MILLISECONDS"),
			double(layers.LONGEST_SPRING_MILLISECONDS),
		),
		...constant("velocitySeconds", fromLayers("VELOCITY_SECONDS"), double(layers.VELOCITY_SECONDS)),
		...constant("leadInSeconds", fromLayers("LEAD_IN_SECONDS"), double(layers.LEAD_IN_SECONDS)),
		"",
		...constant("eyeTravelX", fromRig("EYE_TRAVEL_X"), double(rig.EYE_TRAVEL_X)),
		...constant("eyeTravelY", fromRig("EYE_TRAVEL_Y"), double(rig.EYE_TRAVEL_Y)),
		...constant("eyeEdgeDip", fromRig("EYE_EDGE_DIP"), double(rig.EYE_EDGE_DIP)),
		...constant("eyeForeshortening", fromRig("EYE_FORESHORTENING"), double(rig.EYE_FORESHORTENING)),
		...constant("headTravelX", fromRig("HEAD_TRAVEL_X"), double(rig.HEAD_TRAVEL_X)),
		...constant("headTravelY", fromRig("HEAD_TRAVEL_Y"), double(rig.HEAD_TRAVEL_Y)),
		...constant("headTiltDegrees", fromRig("HEAD_TILT_DEGREES"), double(rig.HEAD_TILT_DEGREES)),
		...constant("eyesSpring", fromRig("EYES_SPRING"), spring(rig.EYES_SPRING)),
		...constant("headSpring", fromRig("HEAD_SPRING"), spring(rig.HEAD_SPRING)),
		...constant("moodSpring", fromRig("MOOD_SPRING"), spring(rig.MOOD_SPRING)),
		...constant(
			"eyeShapeMoodSpring",
			fromRig("EYE_SHAPE_MOOD_SPRING"),
			spring(rig.EYE_SHAPE_MOOD_SPRING),
		),
		...constant("blink", fromRig("BLINK"), valueKeyframes(rig.BLINK)),
		...constant(
			"blinkTwiceGapSeconds",
			fromRig("BLINK_TWICE_GAP_SECONDS"),
			double(rig.BLINK_TWICE_GAP_SECONDS),
		),
		...constant(
			"watchingRestSeconds",
			fromRig("WATCHING_REST_MS", "in seconds"),
			double(rig.WATCHING_REST_MS / 1000),
		),
		...constant("flutter", fromRig("FLUTTER"), valueKeyframes(rig.FLUTTER)),
		...constant("wiggleMove", fromRig("WIGGLE_MOVE"), keyframes(rig.WIGGLE_MOVE)),
		...constant("wiggleTilt", fromRig("WIGGLE_TILT"), keyframes(rig.WIGGLE_TILT)),
		...constant("dotRise", fromRig("DOT_RISE"), keyframes(rig.DOT_RISE)),
		...constant(
			"dotStaggerSeconds",
			fromRig("DOT_STAGGER_SECONDS"),
			double(rig.DOT_STAGGER_SECONDS),
		),
		...constant("outerDotsGrow", fromRig("OUTER_DOTS_GROW"), closedRange(rig.OUTER_DOTS_GROW)),
		...constant("middleDotGrows", fromRig("MIDDLE_DOT_GROWS"), closedRange(rig.MIDDLE_DOT_GROWS)),
		...constant(
			"stillingSeconds",
			fromRig("STILLING", "its `seconds`"),
			double(rig.STILLING.seconds),
		),
		...constant("stillingEase", fromRig("STILLING", "its `ease`"), {
			type: "Easing",
			code: easing(rig.STILLING.ease),
		}),
		"",
		...constant("hopSeconds", { source: "HOP_SECONDS", file: "hop.ts" }, double(hop.HOP_SECONDS)),
		...constant(
			"fullHop",
			{ source: "FULL_HOP", file: "hop.ts", note: "by the layer each path list moves" },
			{
				type: "[FaceLayer: [FacePath]]",
				code: `[${Object.entries(hop.FULL_HOP)
					.map(([layer, paths]) => `.${layer}: [${paths.map(path).join(", ")}]`)
					.join(", ")}]`,
			},
		),
		"",
		...constant("idleBlinkChance", fromMoods("IDLE_BLINK_CHANCE"), double(moods.IDLE_BLINK_CHANCE)),
		...constant(
			"doubleBlinkChance",
			fromMoods("DOUBLE_BLINK_CHANCE"),
			double(moods.DOUBLE_BLINK_CHANCE),
		),
		...constant("lookAheadChance", fromMoods("LOOK_AHEAD_CHANCE"), double(moods.LOOK_AHEAD_CHANCE)),
		...constant("idleGlanceReach", fromMoods("IDLE_GLANCE_REACH"), double(moods.IDLE_GLANCE_REACH)),
		...constant(
			"longGlanceDistance",
			fromMoods("LONG_GLANCE_DISTANCE"),
			double(moods.LONG_GLANCE_DISTANCE),
		),
		...constant(
			"longGlanceBlinkChance",
			fromMoods("LONG_GLANCE_BLINK_CHANCE"),
			double(moods.LONG_GLANCE_BLINK_CHANCE),
		),
		...constant("happyBounce", fromMoods("HAPPY_BOUNCE"), double(moods.HAPPY_BOUNCE)),
		...constant(
			"happyBounceChance",
			fromMoods("HAPPY_BOUNCE_CHANCE"),
			double(moods.HAPPY_BOUNCE_CHANCE),
		),
		...constant(
			"happyBlinkChance",
			fromMoods("HAPPY_BLINK_CHANCE"),
			double(moods.HAPPY_BLINK_CHANCE),
		),
		...constant(
			"happyGlanceReach",
			fromMoods("HAPPY_GLANCE_REACH"),
			double(moods.HAPPY_GLANCE_REACH),
		),
		...constant("excitedBounce", fromMoods("EXCITED_BOUNCE"), {
			type: "Span",
			code: span(moods.EXCITED_BOUNCE),
		}),
		...constant(
			"excitedFullHopChance",
			fromMoods("EXCITED_FULL_HOP_CHANCE"),
			double(moods.EXCITED_FULL_HOP_CHANCE),
		),
		...constant("flutterChance", fromMoods("FLUTTER_CHANCE"), double(moods.FLUTTER_CHANCE)),
		...constant(
			"glanceLeastShare",
			fromMoods("GLANCE_LEAST_SHARE"),
			double(moods.GLANCE_LEAST_SHARE),
		),
		...constant(
			"glanceVerticalShare",
			fromMoods("GLANCE_VERTICAL_SHARE"),
			double(moods.GLANCE_VERTICAL_SHARE),
		),
		"",
		...constant(
			"oftenRestShare",
			{ source: "OFTEN_REST_SHARE", file: "mood-loop.ts" },
			double(moodLoop.OFTEN_REST_SHARE),
		),
		...constant(
			"watchingReach",
			{ source: "WATCHING_REACH", file: "watching.ts" },
			double(watching.WATCHING_REACH),
		),
		...constant(
			"watchingJumpSeconds",
			{ source: "JUMP_INTERVAL_MS", file: "watching.ts", note: "in seconds" },
			double(watching.JUMP_INTERVAL_MS / 1000),
		),
		"",
		...constant(
			"watchingMoods",
			{ source: "WATCHING_MOODS", file: "screen-moods.ts" },
			moodLoopValue(screenMoods.WATCHING_MOODS),
		),
		...constant(
			"creationMoods",
			{ source: "CREATION_MOODS", file: "screen-moods.ts" },
			moodLoopValue(screenMoods.CREATION_MOODS),
		),
		"}",
		"",
	];
	return { files: new Map([["Sugabots/Design/FaceMotion.generated.swift", lines.join("\n")]]) };
}
