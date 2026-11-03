import { cn } from "cn";
import { useInView } from "motion/react";
import {
	type ComponentProps,
	type ReactNode,
	type Ref,
	type RefObject,
	useEffect,
	useId,
	useImperativeHandle,
	useRef,
} from "react";
import { botColors } from "./bot-colors.ts";
import { BotFace, type BotLook } from "./bot-face.tsx";
import { LivelyEyes, ThinkingDots } from "./eyes.tsx";
import { Part, partKey } from "./face-drawing.tsx";
import { FACE_VIEWBOX_SIZE, viewboxPercentage } from "./face-marks.ts";
import { type FaceControls, useFaceRig } from "./face-rig.ts";
import { type EyePlacement, type HeadPart, headShape } from "./head-shapes.ts";
import { type LayerName, restingStyle } from "./layer-motion.ts";
import { useLiveliness } from "./liveliness.ts";
import { type BotMood, moods } from "./moods.ts";
import { repeatAtRandom } from "./random.ts";
import { useWatching } from "./watching.ts";

/** Something a lively face does once, on request. Adding one is adding an entry to `actions`. */
export type FaceAction = "hop";

const actions: Record<FaceAction, (face: FaceControls) => void> = {
	hop: (face) => face.hop(),
};

/** A lively face, as its `ref` gives it. */
export interface LivelyFace {
	play(action: FaceAction): void;
}

/** What a lively face does, apart from how it looks. */
export interface LivelyBehaviour {
	/** How it carries itself; `idle` unless given. */
	mood?: BotMood;
	/** Its eyes follow the pointer while it moves, and wander again once it rests. */
	watchPointer?: boolean;
	/** Its eyes turn to where someone types on the page, and wander again once they stop. */
	watchTyping?: boolean;
	/** Plays actions on the face, such as a hop as the pointer comes onto it. */
	ref?: Ref<LivelyFace>;
}

type LivelyBotFaceProps = BotLook &
	LivelyBehaviour &
	Pick<ComponentProps<"svg">, "width" | "height" | "className">;

/**
 * A bot's face that seems alive, in a mood (see `moods`), and playing actions
 * through its `ref`. Its eyes slide across the head and narrow towards its
 * edge while the head leans after them, which makes the flat head read as
 * round. It hops when pressed. Sized like `BotFace`. Where faces may not move
 * (see `useLiveliness`) it is the still `BotFace`, and off screen it holds still.
 */
export function LivelyBotFace(props: LivelyBotFaceProps) {
	if (useLiveliness() === "off") {
		const { color, face, shape, width, height, className } = props;
		return <BotFace {...{ color, face, shape, width, height, className }} />;
	}
	return <AnimatedBotFace {...props} />;
}

function AnimatedBotFace({
	color,
	face,
	shape = "circle",
	mood = "idle",
	watchPointer = false,
	watchTyping = false,
	ref,
	width,
	height,
	className,
}: LivelyBotFaceProps) {
	const root = useRef<HTMLSpanElement>(null);
	// Taken to be on screen until seen otherwise, so a face shows its mood as soon as it appears.
	const inView = useInView(root, { initial: true });
	const shown = moods[inView ? mood : "still"];
	const { controls, drawing } = useFaceRig(shown.look, root);

	useImperativeHandle(ref, () => ({ play: (action) => actions[action](controls) }), [controls]);
	useWatching(
		controls,
		root,
		{ pointer: watchPointer, typing: watchTyping },
		shown.watches === true,
	);

	useEffect(() => {
		const { gaze, start, act } = shown;
		controls.lookAt(gaze?.x ?? 0, gaze?.y ?? 0);
		const stopGoingOn = start?.(controls);
		const stopActing = act && repeatAtRandom(act.pause, () => act.run(controls), act.firstPause);
		return () => {
			stopGoingOn?.();
			stopActing?.();
		};
	}, [shown, controls]);

	const { face: faceColor, eyes: eyeColor } = botColors[color];
	const head = headShape(shape);
	const { layers } = drawing;
	const clipId = useId();
	/*
	 * Each layer below holds one kind of motion. The head's are nested so all
	 * its moves come before all its turns, which turn it about the middle of
	 * its bottom edge. A hop lifts it out past the top of its box.
	 */
	return (
		<span
			ref={root}
			aria-hidden
			// Pressed, it hops; it's only a face, so this is play, not an action anyone needs.
			onPointerDown={() => controls.hop()}
			className={cn("relative inline-block shrink-0", className)}
			style={{ width, height }}
		>
			<HeadClip id={clipId} parts={head.parts} />
			<Layer layer={layers.hopRise} rest="hopRise">
				<Layer layer={layers.hopSquash} rest="hopSquash" aboutBottom>
					<Layer layer={layers.gazeMove} rest="gazeMove">
						<Layer layer={layers.moodMove} rest="moodMove">
							<Layer layer={layers.wiggleMove} rest="wiggleMove">
								<Layer layer={layers.gazeTilt} rest="gazeTilt" aboutBottom>
									<Layer layer={layers.moodTilt} rest="moodTilt" aboutBottom>
										<Layer layer={layers.wiggleTilt} rest="wiggleTilt" aboutBottom>
											<svg
												aria-hidden
												viewBox={`0 0 ${FACE_VIEWBOX_SIZE} ${FACE_VIEWBOX_SIZE}`}
												overflow="visible"
												className="absolute inset-0 size-full"
											>
												<g fill={faceColor}>
													{head.parts.map((part) => (
														<Part key={partKey(part)} part={part} />
													))}
												</g>
											</svg>
											{/* The eyes never show past the head's edge, however far they look. */}
											<span className={LAYER} style={{ clipPath: `url(#${clipId})` }}>
												<span className={LAYER} style={{ transform: eyePlacement(head.eyes) }}>
													<Layer layer={layers.hopEyesDrop} rest="hopEyesDrop">
														<Layer layer={layers.eyesLift} rest="eyesLift">
															<Layer layer={layers.eyesGaze} rest="eyesGaze">
																<svg
																	aria-hidden
																	viewBox={`0 0 ${FACE_VIEWBOX_SIZE} ${FACE_VIEWBOX_SIZE}`}
																	overflow="visible"
																	className="absolute inset-0 size-full"
																>
																	<LivelyEyes face={face} color={eyeColor} drawing={drawing} />
																</svg>
																<ThinkingDots color={eyeColor} drawing={drawing} />
															</Layer>
														</Layer>
													</Layer>
												</span>
											</span>
										</Layer>
									</Layer>
								</Layer>
							</Layer>
						</Layer>
					</Layer>
				</Layer>
			</Layer>
		</span>
	);
}

/** A layer filling the face's box, which its transforms move. */
const LAYER = "absolute inset-0";

/**
 * One layer of the face, holding one kind of motion, which the browser
 * animates through `layer`; it starts at its resting transform. One that
 * turns or squashes does so `aboutBottom`, the middle of the face's bottom edge.
 */
function Layer({
	layer,
	rest,
	aboutBottom = false,
	children,
}: {
	layer: RefObject<HTMLSpanElement | null>;
	rest: LayerName;
	aboutBottom?: boolean;
	children: ReactNode;
}) {
	return (
		<span
			ref={layer}
			className={cn(LAYER, aboutBottom && "origin-bottom")}
			style={restingStyle(rest)}
		>
			{children}
		</span>
	);
}

/**
 * Where the eyes sit on the head: the full-size face they're drawn for, moved
 * to the head's eye centre and scaled to its eyes.
 */
function eyePlacement({ x, y, scale }: EyePlacement): string {
	const half = FACE_VIEWBOX_SIZE / 2;
	return `translate(${viewboxPercentage(x - half)}%, ${viewboxPercentage(y - half)}%) scale(${scale})`;
}

/** The head's outline as a clip path for the eyes' layer, in fractions of the layer's box. */
function HeadClip({ id, parts }: { id: string; parts: readonly HeadPart[] }) {
	const toFractions = `scale(${1 / FACE_VIEWBOX_SIZE})`;
	return (
		<svg aria-hidden width="0" height="0" className="absolute">
			<clipPath id={id} clipPathUnits="objectBoundingBox">
				{parts.map((part) =>
					part.kind === "circle" ? (
						<circle
							key={partKey(part)}
							cx={part.cx}
							cy={part.cy}
							r={part.r}
							transform={toFractions}
						/>
					) : (
						<path key={partKey(part)} d={part.d} transform={toFractions} />
					),
				)}
			</clipPath>
		</svg>
	);
}
