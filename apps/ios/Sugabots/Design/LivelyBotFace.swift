import SwiftUI

/*
 * Bots' faces that seem alive, as `LivelyBotFace` and its kin in
 * `@sugabots/avatars` and the web's `shell/Agent.tsx`.
 */

extension Liveliness {
	/// Where the choice is kept on this device, as the web keeps it in each browser.
	static let storageKey = "sugabots-liveliness"

	/// What each level is called in settings, as the web's `livelinessNames`.
	var label: String {
		switch self {
		case .off: "Off"
		case .sometimes: "Sometimes"
		case .often: "Often"
		}
	}
}

private struct LivelinessKey: EnvironmentKey {
	/// With nothing set, faces stay still, so a preview only gets movement it asks for.
	static let defaultValue = Liveliness.off
}

extension EnvironmentValues {
	/// How much the faces inside may move: as chosen, or not at all when the system asks for reduced motion.
	var liveliness: Liveliness {
		get { self[LivelinessKey.self] }
		set { self[LivelinessKey.self] = newValue }
	}
}

/// Where someone last typed, in the window's points, for faces that watch typing, as the web's faces watch `input` events.
@MainActor
@Observable
final class TypingWatch {
	private(set) var latest: Typed?

	struct Typed: Equatable {
		let point: CGPoint
		let at: Double
	}

	func typed(at point: CGPoint) {
		latest = Typed(point: point, at: FaceClock.now())
	}
}

/// A bot's face that seems alive, in `mood` (see `BotMood`): its eyes slide
/// across the head and narrow towards its edge while the head leans after
/// them. It hops when tapped. Where faces may not move (see `liveliness`) it
/// is the still `BotFace`.
struct LivelyBotFace: View {
	let look: BotLook
	var size: CGFloat = 24
	var mood = BotMood.idle
	/// Its eyes turn to where someone types, and wander again once they stop.
	var watchTyping = false
	/// It hops whenever its look changes, as the bot being made does.
	var hopsOnNewLook = false
	@Environment(\.liveliness) private var liveliness

	var body: some View {
		if liveliness == .off {
			BotFace(look: look, size: size)
		} else {
			AnimatedBotFace(look: look, size: size, mood: mood, watchTyping: watchTyping, hopsOnNewLook: hopsOnNewLook)
		}
	}
}

@MainActor
private struct AnimatedBotFace: View {
	let look: BotLook
	let size: CGFloat
	let mood: BotMood
	let watchTyping: Bool
	let hopsOnNewLook: Bool
	@State private var rig = FaceRig()
	@State private var frame = CGRect.zero
	@Environment(TypingWatch.self) private var typing: TypingWatch?

	var body: some View {
		let moving = rig.moving
		let settledAt = rig.settledAt
		// Read so a face at rest is drawn again when a part jumps.
		let _ = rig.revision
		let art = FaceArt(look: look)
		TimelineView(.animation(minimumInterval: FaceMotion.tickSeconds, paused: !moving)) { timeline in
			let pose = rig.pose(at: moving ? FaceClock.tick(at: timeline.date) : settledAt)
			Canvas { context, canvas in
				FaceDrawing.draw(art, pose: pose, in: &context, canvas: canvas, overflow: Self.overflow)
			}
			.frame(width: size * (1 + 2 * Self.overflow), height: size * (1 + 2 * Self.overflow))
			.allowsHitTesting(false)
		}
		.frame(width: size, height: size)
		.contentShape(Rectangle())
		// Tapped, it hops; it's only a face, so this is play, not an action anyone needs.
		.simultaneousGesture(TapGesture().onEnded { rig.hop() })
		.background {
			if watchTyping {
				GeometryReader { proxy in
					Color.clear
						.onAppear { frame = proxy.frame(in: .global) }
						.onChange(of: proxy.frame(in: .global)) { _, next in frame = next }
				}
			}
		}
		.onAppear { rig.enter(mood) }
		.onDisappear { rig.stopAll() }
		.onChange(of: mood) { _, next in rig.enter(next) }
		.onChange(of: look) { if hopsOnNewLook { rig.hop() } }
		.onChange(of: watchTyping ? typing?.latest : nil) { _, typed in
			guard let typed, mood.mood.watches else { return }
			rig.watchTyping(at: typed.point, from: frame)
		}
		.accessibilityHidden(true)
	}

	/// How far past its box a face is drawn on each side, as a share of its size, so a hop or a lean isn't cut off.
	private static let overflow = 0.35
}

/// What a face is drawn with, by its look.
struct FaceArt {
	let palette: BotPalette
	let head: HeadShape
	let marks: [FaceMark]

	init(look: BotLook) {
		palette = BotLooks.palettes[look.color] ?? BotLooks.palettes["green"]!
		head = BotLooks.heads[look.shape] ?? BotLooks.heads["circle"]!
		marks = BotLooks.faces[look.face] ?? BotLooks.faces["dot"]!
	}
}

/// Draws a lively face in a pose, layer by layer as the web's `AnimatedBotFace`
/// nests them: the head's moves, then its turns about the middle of its
/// bottom edge; then, clipped to the head, the eyes' moves and the eyes.
enum FaceDrawing {
	/// The side of the square faces are drawn in, as `FACE_VIEWBOX_SIZE`.
	static let viewboxSize = 40.0

	static func draw(_ art: FaceArt, pose: FacePose, in context: inout GraphicsContext, canvas: CGSize, overflow: Double) {
		let side = canvas.width / (1 + 2 * overflow)
		context.translateBy(x: side * overflow, y: side * overflow)
		context.scaleBy(x: side / viewboxSize, y: side / viewboxSize)
		let units = { (percent: Double) in percent * viewboxSize / 100 }
		let bottom = CGPoint(x: viewboxSize / 2, y: viewboxSize)
		let centre = CGPoint(x: viewboxSize / 2, y: viewboxSize / 2)

		var head = context
		head.translateBy(x: 0, y: units(pose.hopRise))
		head.about(bottom) { $0.scaleBy(x: pose.hopSquash.width, y: pose.hopSquash.height) }
		head.translateBy(x: units(pose.gazeMove.x + pose.wiggleMove), y: units(pose.gazeMove.y + pose.moodMove))
		for degrees in [pose.gazeTiltDegrees, pose.moodTiltDegrees, pose.wiggleTiltDegrees] {
			head.about(bottom) { $0.rotate(by: .degrees(degrees)) }
		}
		var outline = Path()
		for part in art.head.parts {
			head.fill(part.path, with: .color(art.palette.face))
			outline.addPath(part.path)
		}

		// The eyes never show past the head's edge, however far they look.
		var eyes = head
		eyes.clip(to: outline)
		let placement = art.head.eyes
		eyes.translateBy(x: placement.x, y: placement.y)
		eyes.scaleBy(x: placement.scale, y: placement.scale)
		eyes.translateBy(x: -centre.x, y: -centre.y)
		eyes.translateBy(x: units(pose.eyesGaze.x), y: units(pose.hopEyesDrop + pose.eyesLift + pose.eyesGaze.y))
		eyes.about(centre) { $0.scaleBy(x: pose.eyesGaze.width, y: 1) }
		let colour = GraphicsContext.Shading.color(art.palette.eyes)
		for mark in art.marks {
			drawEye(mark, pose: pose, colour: colour, in: eyes)
		}
		drawThinkingDots(pose: pose, colour: colour, in: eyes)
	}

	/// One mark, shrunk as the dots grow: an arc eye flattened as the mood
	/// says; an open eye as tall as it's held, fading as it closes into a smile.
	private static func drawEye(_ mark: FaceMark, pose: FacePose, colour: GraphicsContext.Shading, in context: GraphicsContext) {
		var eye = context
		eye.about(mark.centre) { $0.scaleBy(x: pose.eyesShrink, y: pose.eyesShrink) }
		switch mark {
		case let .stroke(data, width):
			// An arc is a shut eye already: it only flattens, never blinks or smiles.
			eye.translateBy(x: 0, y: -pose.arcsFlat * arcShutRise)
			eye.stroke(SVGPath.path(flattenArcs(data, by: pose.arcsFlat)), with: colour, lineWidth: width)
		case .circle, .rect:
			var open = eye
			open.opacity = shareOf(pose.smile, from: 0, to: 0.5, reversed: true)
			// However shut, it stays as thick as an arc eye's line, so it never thins to a hairline.
			open.about(mark.centre) { $0.scaleBy(x: 1, y: max(pose.eyeHeight, arcEyeStrokeWidth / mark.drawnHeight)) }
			mark.draw(in: open, with: colour, cap: .butt)
			drawSmileArc(over: mark, smile: pose.smile, colour: colour, in: eye)
		}
	}

	/// The upturned arc an open eye closes into as the bot smiles: the top half
	/// of a ring a little wider than the eye, growing up from a flat line.
	private static func drawSmileArc(over eye: FaceMark, smile: Double, colour: GraphicsContext.Shading, in context: GraphicsContext) {
		guard smile > 0 else { return }
		let centre = eye.centre
		let radius = eye.drawnWidth / 2 + 0.6
		let baseline = centre.y + radius * 0.4
		var arc = context
		arc.opacity = shareOf(smile, from: 0, to: 0.3, reversed: false)
		arc.about(CGPoint(x: centre.x, y: baseline)) { $0.scaleBy(x: 1, y: smile) }
		let path = Path { path in
			path.addArc(center: CGPoint(x: centre.x, y: baseline), radius: radius, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
		}
		arc.stroke(path, with: colour, lineWidth: arcEyeStrokeWidth)
	}

	/// A thinking bot's three dots, across where its eyes were, grown in as the mood turns to thinking.
	private static func drawThinkingDots(pose: FacePose, colour: GraphicsContext.Shading, in context: GraphicsContext) {
		let grows = [pose.outerDotsGrow, pose.middleDotGrows, pose.outerDotsGrow]
		for (index, x) in thinkingDotXs.enumerated() where index < pose.dots.count && grows[index] > 0 {
			let (rise, opacity) = pose.dots[index]
			var dot = context
			dot.opacity = opacity
			let radius = thinkingDotRadius * grows[index]
			let centre = CGPoint(x: x, y: thinkingDotY - rise * thinkingDotRadius * 2)
			dot.fill(Path(ellipseIn: CGRect(x: centre.x - radius, y: centre.y - radius, width: radius * 2, height: radius * 2)), with: colour)
		}
	}

	/// How far `value` is from `from` to `to`, from 0 to 1, or from 1 to 0 when `reversed`.
	private static func shareOf(_ value: Double, from: Double, to: Double, reversed: Bool) -> Double {
		let share = min(1, max(0, (value - from) / (to - from)))
		return reversed ? 1 - share : share
	}

	/// The arc eyes' path with each arc's height cut by `flat`, from 0 (as drawn) to 1 (a straight line), as `flattenArcs`.
	private static func flattenArcs(_ data: String, by flat: Double) -> String {
		guard flat > 0 else { return data }
		return data.replacing(arcRadii) { match in
			let width = match.output[1].substring ?? ""
			let height = Double(match.output[2].substring ?? "") ?? 0
			return "a\(width) \(max(height * (1 - flat), minimumArcHeight))"
		}
	}

	/// An arc's radii in the arc eyes' path: its relative `a` commands' first two numbers.
	private static let arcRadii = try! Regex(#"a([\d.]+) ([\d.]+)"#)
	/// The flattest an arc is drawn, so it never quite becomes a line its path can't bend.
	private static let minimumArcHeight = 0.01

	/*
	 * The eyes' own geometry, as `eyes.tsx` and `face-marks.ts` draw it, on
	 * the 40-unit face the marks are drawn for.
	 */
	/// How thick an arc eye's line is; a shut or smiling eye is drawn as thick.
	private static let arcEyeStrokeWidth = 1.8
	/// How far an arc eye rises as it shuts, to sit level with open eyes shut as far.
	private static let arcShutRise = 2.0
	private static let thinkingDotRadius = 2.4
	private static let thinkingDotXs = [14.0, 20, 26]
	private static let thinkingDotY = 20.0
}

private extension GraphicsContext {
	/// Applies `transform` about `point` rather than the origin, as a CSS transform origin does.
	mutating func about(_ point: CGPoint, _ transform: (inout GraphicsContext) -> Void) {
		translateBy(x: point.x, y: point.y)
		transform(&self)
		translateBy(x: -point.x, y: -point.y)
	}
}

private extension FaceMark {
	/// The middle of the mark's outline, which it shrinks and squeezes about.
	var centre: CGPoint {
		switch self {
		case let .circle(cx, cy, _): CGPoint(x: cx, y: cy)
		case let .rect(x, y, width, height, _): CGPoint(x: x + width / 2, y: y + height / 2)
		case let .stroke(data, _):
			CGPoint(x: SVGPath.path(data).boundingRect.midX, y: SVGPath.path(data).boundingRect.midY)
		}
	}

	var drawnWidth: Double {
		switch self {
		case let .circle(_, _, r): r * 2
		case let .rect(_, _, width, _, _): width
		case let .stroke(data, _): SVGPath.path(data).boundingRect.width
		}
	}

	var drawnHeight: Double {
		switch self {
		case let .circle(_, _, r): r * 2
		case let .rect(_, _, _, height, _): height
		case let .stroke(data, _): SVGPath.path(data).boundingRect.height
		}
	}
}

/// The face of a bot someone is talking to, as the web's `WatchingAvatar`:
/// thinking while the bot is `busy`; else, while `watching`, following the
/// typing and moving through `FaceMotion.watchingMoods`; else still.
struct WatchingFace: View {
	let look: BotLook
	let size: CGFloat
	let busy: Bool
	let watching: Bool
	@State private var watchingMood = FaceMotion.watchingMoods.rest.mood

	var body: some View {
		LivelyBotFace(look: look, size: size, mood: busy ? .thinking : watching ? watchingMood : .still, watchTyping: true)
			.moodLoop(FaceMotion.watchingMoods, running: watching && !busy, mood: $watchingMood)
	}
}

/// A bot's face among others in a `LivelyGroup`, as the web's
/// `TurnTakingAvatar`: still except on its turn to move.
struct TurnTakingFace: View {
	let look: BotLook
	let size: CGFloat
	@Environment(FaceTurns.self) private var turns: FaceTurns?
	@State private var member = UUID()

	var body: some View {
		LivelyBotFace(look: look, size: size, mood: turns?.isMoving(member) == true ? .idle : .still)
			.onAppear { turns?.join(member) }
			.onDisappear { turns?.leave(member) }
	}
}

extension View {
	/// Moves `mood` through `loop` while `running`, as `useMoodLoop`; otherwise holds it at the loop's resting mood.
	func moodLoop(_ loop: MoodLoop, running: Bool, mood: Binding<BotMood>) -> some View {
		modifier(MoodLoopModifier(loop: loop, running: running, mood: mood))
	}
}

private struct MoodLoopModifier: ViewModifier {
	let loop: MoodLoop
	let running: Bool
	@Binding var mood: BotMood
	@Environment(\.liveliness) private var liveliness

	func body(content: Content) -> some View {
		content.task(id: Run(running: running, liveliness: liveliness)) {
			mood = loop.rest.mood
			guard running, liveliness != .off else { return }
			await loop.run(liveliness: liveliness) { mood = $0 }
		}
	}

	/// What restarts the loop when it changes.
	private struct Run: Equatable {
		let running: Bool
		let liveliness: Liveliness
	}
}

/// Faces in a group, such as a list of bots, mostly sit still and take short
/// turns moving, so only a few move at once and the list doesn't fidget, as
/// the web's `LivelyGroup`.
@MainActor
struct LivelyGroup<Content: View>: View {
	let content: Content
	@State private var turns = FaceTurns()
	@Environment(\.liveliness) private var liveliness

	init(@ViewBuilder content: () -> Content) {
		self.content = content()
	}

	var body: some View {
		content
			.environment(turns)
			.task(id: liveliness) {
				guard let pacing = liveliness.groupPacing else { return }
				await turns.takeTurns(pacing)
			}
	}
}

extension View {
	/// Paces the faces inside so they take turns to move (see `LivelyGroup`).
	@MainActor func livelyGroup() -> some View {
		LivelyGroup { self }
	}
}

/// The faces in a group, and whose turn it is to move.
@MainActor
@Observable
final class FaceTurns {
	private var moving: Set<UUID> = []
	@ObservationIgnored private var members: Set<UUID> = []
	@ObservationIgnored private var turnEndings: [UUID: Task<Void, Never>] = [:]

	func isMoving(_ member: UUID) -> Bool {
		moving.contains(member)
	}

	func join(_ member: UUID) {
		members.insert(member)
	}

	func leave(_ member: UUID) {
		members.remove(member)
		moving.remove(member)
		turnEndings.removeValue(forKey: member)?.cancel()
	}

	/// Gives turns to faces not already moving, while fewer than the pacing allows are, until cancelled.
	func takeTurns(_ pacing: GroupPacing) async {
		while (try? await Task.sleep(for: .seconds(pacing.gapSeconds.random()))) != nil {
			guard moving.count < pacing.movingAtOnce, let member = members.subtracting(moving).randomElement() else { continue }
			moving.insert(member)
			turnEndings[member] = Task { [weak self] in
				_ = try? await Task.sleep(for: .seconds(pacing.turnSeconds.random()))
				self?.moving.remove(member)
			}
		}
		for ending in turnEndings.values { ending.cancel() }
		turnEndings = [:]
		moving = []
	}
}
