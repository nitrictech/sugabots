import CoreGraphics
import Foundation
import Observation

/// Where the eyes look, from -1 to 1 on each axis, as a mood's `gaze`.
struct Gaze {
	let x: Double
	let y: Double

	static let ahead = Gaze(x: 0, y: 0)
}

/// How a mood holds the face, eased into whenever the mood changes, as `MoodLook`.
/// Distances are in the face's 40-unit viewbox.
struct MoodLook: Equatable {
	/// How open the eyes are, 1 being wide open.
	let eyesOpen: Double
	/// How far each open eye has become a smiling arc, 0 not at all.
	let smile: Double
	/// How far an arc eye has flattened into a shut lid.
	let arcsFlat: Double
	/// How far the eyes have given way to three thinking dots, 0 not at all.
	let dots: Double
	/// How far the eyes sit above (negative) or below their place.
	let eyesLift: Double
	/// How far the head sinks, and leans in degrees.
	let headDrop: Double
	let headLean: Double
}

/// A small act a mood repeats, after a pause in seconds picked from `pause` each time; the first from `firstPause`.
struct MoodAct {
	let pause: Span
	let firstPause: Span
}

/// One way a bot carries itself, as an entry in `moods`: how it holds its
/// face, where it looks as the mood starts, whether its eyes may follow
/// typing, and how often it acts. What it does is `BotMood.start` and `BotMood.act`.
struct Mood {
	let look: MoodLook
	let gaze: Gaze
	let watches: Bool
	let act: MoodAct?
}

/*
 * What each mood does, copied from the functions in `moods.ts`; its numbers
 * and chances are generated.
 */
extension BotMood {
	/// Starts what goes on for as long as the mood lasts; returns what eases it to a stop.
	@MainActor func start(on face: FaceRig) -> (() -> Void)? {
		switch self {
		case .thinking:
			return face.riseDots()
		case .excited:
			face.hop()
			return face.wiggle()
		case .still, .idle, .happy, .sleepy:
			return nil
		}
	}

	/// The small act the mood repeats.
	@MainActor func act(on face: FaceRig) {
		switch self {
		case .idle: glanceOrBlink(face)
		case .happy: bounceOrBlink(face)
		case .excited: bounceOrHop(face)
		case .sleepy: if Self.happens(FaceMotion.flutterChance) { face.flutter() }
		case .still, .thinking: break
		}
	}

	/// Blinks now and then; otherwise glances somewhere new, unless it's watching typing.
	@MainActor private func glanceOrBlink(_ face: FaceRig) {
		if face.isWatching || Self.happens(FaceMotion.idleBlinkChance) {
			face.blink(twice: Self.happens(FaceMotion.doubleBlinkChance))
			return
		}
		let gaze = Self.happens(FaceMotion.lookAheadChance) ? Gaze.ahead : Self.randomGlance(reach: FaceMotion.idleGlanceReach)
		// People blink as their eyes shift a long way.
		if face.look(at: gaze) > FaceMotion.longGlanceDistance, Self.happens(FaceMotion.longGlanceBlinkChance) { face.blink() }
	}

	@MainActor private func bounceOrBlink(_ face: FaceRig) {
		let roll = Double.random(in: 0 ..< 1)
		if roll < FaceMotion.happyBounceChance {
			face.hop(size: FaceMotion.happyBounce)
		} else if roll < FaceMotion.happyBounceChance + FaceMotion.happyBlinkChance {
			face.blink()
		} else if !face.isWatching {
			face.look(at: Self.randomGlance(reach: FaceMotion.happyGlanceReach))
		}
	}

	@MainActor private func bounceOrHop(_ face: FaceRig) {
		// Never cuts a hop short in the air.
		guard !face.isAirborne else { return }
		face.hop(size: Self.happens(FaceMotion.excitedFullHopChance) ? 1 : FaceMotion.excitedBounce.random())
	}

	/// Whether something with `chance` of happening, from 0 to 1, happens this time.
	private static func happens(_ chance: Double) -> Bool {
		Double.random(in: 0 ..< 1) < chance
	}

	/// Somewhere to glance, up to `reach` from straight ahead, in any direction, as `randomGlance`.
	private static func randomGlance(reach: Double) -> Gaze {
		let angle = Double.random(in: 0 ..< 1) * .pi * 2
		let distance = (FaceMotion.glanceLeastShare + Double.random(in: 0 ..< 1) * (1 - FaceMotion.glanceLeastShare)) * reach
		return Gaze(x: cos(angle) * distance, y: sin(angle) * distance * FaceMotion.glanceVerticalShare)
	}
}

/// Where each of a face's parts is at one moment, which is all it takes to draw it.
/// Translations are percentages of the face, as the web's layers move.
struct FacePose {
	let hopRise: Double
	let hopSquash: (width: Double, height: Double)
	let gazeMove: (x: Double, y: Double)
	let moodMove: Double
	let wiggleMove: Double
	let gazeTiltDegrees: Double
	let moodTiltDegrees: Double
	let wiggleTiltDegrees: Double
	let hopEyesDrop: Double
	let eyesLift: Double
	let eyesGaze: (x: Double, y: Double, width: Double)
	/// Each thinking dot's rise, as a share of its height, and brightness.
	let dots: [(rise: Double, opacity: Double)]
	/// How tall an open eye is drawn, before the shut-eye minimum.
	let eyeHeight: Double
	let eyesShrink: Double
	let smile: Double
	let arcsFlat: Double
	let outerDotsGrow: Double
	let middleDotGrows: Double
}

/// A lively face's moving parts, as `useFaceRig`: held as its mood's look
/// says, and moved by its mood's acts. It knows when anything is moving, so
/// its face is redrawn on the clock's ticks only then.
@MainActor
@Observable
final class FaceRig {
	/// Whether any part is moving now.
	private(set) var moving = false
	/// Counts every change to the parts, so a face at rest is drawn again when one jumps.
	private(set) var revision = 0
	/// When the last part to move comes to rest.
	private(set) var settledAt = 0.0

	/// The parts that have been moved or set; any other is at its rest.
	@ObservationIgnored private var parts: [Part: FaceTrack] = [:]
	@ObservationIgnored private var settling: Task<Void, Never>?
	@ObservationIgnored private var gaze = Gaze.ahead
	@ObservationIgnored private var watchedAt = -Double.infinity
	@ObservationIgnored private var landsAt = 0.0
	@ObservationIgnored private var heldLook: MoodLook?
	@ObservationIgnored private var stopGoingOn: (() -> Void)?
	@ObservationIgnored private var acting: Task<Void, Never>?
	@ObservationIgnored private var lastJumpToTyping = -Double.infinity
	@ObservationIgnored private var jumpingToTyping: Task<Void, Never>?
	@ObservationIgnored private var typingTarget: (point: CGPoint, face: CGRect)?

	/// The face's parts: the web's layers, and the values its eyes' shapes are drawn with.
	private enum Part: Hashable {
		/// One of the face's layers, other than a thinking dot's.
		case layer(FaceLayer)
		/// The thinking dot at this index, from the left, on a layer of the `dot` kind.
		case thinkingDot(Int)
		case blink, flutter, eyesOpen, smile, arcsFlat, dots

		var rest: [Double] {
			let resting = BotMood.still.mood.look
			switch self {
			case let .layer(layer): return layer.rest
			case .thinkingDot: return FaceLayer.dot.rest
			case .blink: return FaceMotion.blink.frames[0]
			case .flutter: return FaceMotion.flutter.frames[0]
			case .eyesOpen: return [resting.eyesOpen]
			case .smile: return [resting.smile]
			case .arcsFlat: return [resting.arcsFlat]
			case .dots: return [resting.dots]
			}
		}

		static let thinkingDots = FaceGeometry.thinkingDotXs.indices.map(Part.thinkingDot)
	}

	// MARK: Moods

	/// Puts the face in `mood`: eases it into the mood's look (or sets it, the
	/// first time), turns its eyes where the mood starts looking, and starts
	/// what the mood does, ending what the last mood did.
	func enter(_ mood: BotMood) {
		leaveMood()
		let behaviour = mood.mood
		hold(behaviour.look)
		look(at: behaviour.gaze)
		stopGoingOn = mood.start(on: self)
		guard let act = behaviour.act else { return }
		acting = Task { [weak self] in
			var pause = act.firstPause
			while (try? await Task.sleep(for: .seconds(pause.random()))) != nil {
				guard let self else { return }
				mood.act(on: self)
				pause = act.pause
			}
		}
	}

	/// Ends what the mood was doing, easing anything it set going to a stop.
	func leaveMood() {
		acting?.cancel()
		acting = nil
		stopGoingOn?()
		stopGoingOn = nil
	}

	/// Stops everything the face does of its own accord, as it goes from
	/// view: its mood's acts, easing to a stop what the mood set going, and
	/// any wait to look at typing. Parts already moving finish by the clock,
	/// so the face is where they end when it shows again.
	func stopActing() {
		leaveMood()
		jumpingToTyping?.cancel()
		jumpingToTyping = nil
	}

	/// Holds the head and eyes as `look` says: eased there gently when the
	/// look changes, and set straight away the first time.
	private func hold(_ look: MoodLook) {
		let first = heldLook == nil
		guard heldLook != look else { return }
		heldLook = look
		let poses: [(Part, [Double], SpringTuning)] = [
			(.layer(.moodMove), [Self.percent(look.headDrop)], FaceMotion.moodSpring),
			(.layer(.moodTilt), [look.headLean], FaceMotion.moodSpring),
			(.layer(.eyesLift), [Self.percent(look.eyesLift)], FaceMotion.moodSpring),
			(.eyesOpen, [look.eyesOpen], FaceMotion.eyeShapeMoodSpring),
			(.smile, [look.smile], FaceMotion.eyeShapeMoodSpring),
			(.arcsFlat, [look.arcsFlat], FaceMotion.eyeShapeMoodSpring),
			(.dots, [look.dots], FaceMotion.eyeShapeMoodSpring),
		]
		for (part, pose, spring) in poses {
			if first { parts[part, default: FaceTrack(rest: part.rest)].jump(to: pose) } else { play(part, [.spring(to: pose, spring)]) }
		}
		changed()
	}

	// MARK: Controls, as `FaceControls`

	/// Turns the eyes, and after them the head, to `gaze`; returns how far they turned.
	@discardableResult
	func look(at target: Gaze) -> Double {
		let distance = hypot(target.x - gaze.x, target.y - gaze.y)
		gaze = target
		let eyes = [
			Self.percent(target.x * FaceMotion.eyeTravelX),
			Self.percent(target.y * FaceMotion.eyeTravelY + abs(target.x) * FaceMotion.eyeEdgeDip),
			1 - abs(target.x) * FaceMotion.eyeForeshortening,
		]
		play(.layer(.eyesGaze), [.spring(to: eyes, FaceMotion.eyesSpring)])
		play(.layer(.gazeMove), [.spring(to: [Self.percent(target.x * FaceMotion.headTravelX), Self.percent(target.y * FaceMotion.headTravelY)], FaceMotion.headSpring)])
		play(.layer(.gazeTilt), [.spring(to: [target.x * FaceMotion.headTiltDegrees], FaceMotion.headSpring)])
		changed()
		return distance
	}

	/// Whether the eyes have been on typing lately, which idle glances then leave alone.
	var isWatching: Bool {
		FaceClock.now() - watchedAt < FaceMotion.watchingRestSeconds
	}

	/// Blinks, as `BLINK`; a double blink holds the eye open `blinkTwiceGapSeconds` between the two.
	func blink(twice: Bool = false) {
		let open = FaceMotion.blink.frames[0]
		let once = FacePath.keyframes(FaceMotion.blink)
		let gap = FacePath.keyframes(Keyframes(frames: [open, open], times: [0, 1], ease: [.linear], seconds: FaceMotion.blinkTwiceGapSeconds))
		play(.blink, twice ? [once, gap, once] : [once], from: open)
		changed()
	}

	/// A hop `size` times as big as a full one; a new hop takes over from one in the air.
	func hop(size: Double = 1) {
		landsAt = FaceClock.now() + FaceMotion.hopSeconds
		for (layer, paths) in FacePath.hop(size: size) {
			play(.layer(layer), paths)
		}
		changed()
	}

	var isAirborne: Bool {
		FaceClock.now() < landsAt
	}

	/// Wiggles the head from side to side until the returned function eases it still.
	func wiggle() -> () -> Void {
		play(.layer(.wiggleMove), [.keyframes(FaceMotion.wiggleMove)], repeating: true)
		play(.layer(.wiggleTilt), [.keyframes(FaceMotion.wiggleTilt)], repeating: true)
		changed()
		return { [weak self] in
			self?.easeToRest([.layer(.wiggleMove), .layer(.wiggleTilt)])
		}
	}

	/// Raises the thinking dots in turn until the returned function settles them.
	func riseDots() -> () -> Void {
		for (index, dot) in Part.thinkingDots.enumerated() {
			play(dot, [.keyframes(FaceMotion.dotRise)], repeating: true, delaySeconds: Double(index) * FaceMotion.dotStaggerSeconds)
		}
		changed()
		return { [weak self] in
			self?.easeToRest(Part.thinkingDots)
		}
	}

	/// Opens the eyes half way for a moment, however shut its mood holds them.
	func flutter() {
		play(.flutter, [.keyframes(FaceMotion.flutter)], from: FaceMotion.flutter.frames[0])
		changed()
	}

	/// Turns the eyes to where someone types, at `point`, from a face at
	/// `face`, both in the window's points, as `useWatching`: at once, then at
	/// most every `watchingJumpSeconds` at the latest point.
	func watchTyping(at point: CGPoint, from face: CGRect) {
		// A face laid out at no size has nowhere to look from.
		guard face.width > 0 else { return }
		typingTarget = (point, face)
		guard jumpingToTyping == nil else { return }
		let wait = lastJumpToTyping + FaceMotion.watchingJumpSeconds - FaceClock.now()
		guard wait > 0 else {
			jumpToTyping()
			return
		}
		jumpingToTyping = Task { [weak self] in
			guard (try? await Task.sleep(for: .seconds(wait))) != nil else { return }
			self?.jumpingToTyping = nil
			self?.jumpToTyping()
		}
	}

	private func jumpToTyping() {
		guard let (point, face) = typingTarget else { return }
		lastJumpToTyping = FaceClock.now()
		let reach = face.width * FaceMotion.watchingReach
		let x = (point.x - face.midX) / reach
		let y = (point.y - face.midY) / reach
		// Pulled in to the edge of where the eyes can look, if it lies further out.
		let distance = max(1, hypot(x, y))
		look(at: Gaze(x: x / distance, y: y / distance))
		watchedAt = FaceClock.now()
	}

	// MARK: Drawing

	/// Where every part is at `time`.
	func pose(at time: Double) -> FacePose {
		Self.pose { part in parts[part]?.values(at: time) ?? part.rest }
	}

	/// The face with every part at rest.
	nonisolated static let restingPose = pose { $0.rest }

	/// The pose with each part's `values`.
	private nonisolated static func pose(_ values: (Part) -> [Double]) -> FacePose {
		func value(_ part: Part) -> Double { values(part)[0] }
		let squash = values(.layer(.hopSquash))
		let gazeMove = values(.layer(.gazeMove))
		let eyesGaze = values(.layer(.eyesGaze))
		let dots = value(.dots)
		return FacePose(
			hopRise: value(.layer(.hopRise)),
			hopSquash: (squash[0], squash[1]),
			gazeMove: (gazeMove[0], gazeMove[1]),
			moodMove: value(.layer(.moodMove)),
			wiggleMove: value(.layer(.wiggleMove)),
			gazeTiltDegrees: value(.layer(.gazeTilt)),
			moodTiltDegrees: value(.layer(.moodTilt)),
			wiggleTiltDegrees: value(.layer(.wiggleTilt)),
			hopEyesDrop: value(.layer(.hopEyesDrop)),
			eyesLift: value(.layer(.eyesLift)),
			eyesGaze: (eyesGaze[0], eyesGaze[1], eyesGaze[2]),
			dots: Part.thinkingDots.map { dot in
				let rise = values(dot)
				return (rise[0], rise[1])
			},
			eyeHeight: value(.blink) * max(value(.eyesOpen), value(.flutter)),
			// The eyes shrink to points as the dots grow from where the eyes were; the middle dot comes last.
			eyesShrink: 1 - dots,
			smile: value(.smile),
			arcsFlat: value(.arcsFlat),
			outerDotsGrow: FaceMotion.outerDotsGrow.share(of: dots),
			middleDotGrows: FaceMotion.middleDotGrows.share(of: dots)
		)
	}

	// MARK: Parts

	private func play(_ part: Part, _ paths: [FacePath], repeating: Bool = false, delaySeconds: Double = 0, from start: [Double]? = nil) {
		parts[part, default: FaceTrack(rest: part.rest)].play(paths, at: FaceClock.now(), repeating: repeating, delaySeconds: delaySeconds, from: start)
	}

	/// Eases parts back to rest.
	private func easeToRest(_ resting: [Part]) {
		for part in resting {
			let rest = part.rest
			play(part, [.keyframes(Keyframes(frames: [rest, rest], times: [0, 1], ease: [FaceMotion.stillingEase], seconds: FaceMotion.stillingSeconds))])
		}
		changed()
	}

	/// Notes that parts have changed: the face is drawn again, and redrawn on each tick until the last comes to rest.
	private func changed() {
		revision += 1
		settledAt = max(0, parts.values.map(\.endsAt).max() ?? 0)
		let now = FaceClock.now()
		moving = settledAt > now
		settling?.cancel()
		guard moving, settledAt.isFinite else { return }
		let wait = settledAt - now
		settling = Task { [weak self] in
			guard (try? await Task.sleep(for: .seconds(wait))) != nil, let self else { return }
			self.moving = self.settledAt > FaceClock.now()
		}
	}

	/// A distance in viewbox units as a percentage of the face, as `viewboxPercentage`.
	static func percent(_ units: Double) -> Double {
		units / FaceGeometry.viewboxSize * 100
	}
}

/// The moods a bot moves between, at random, by weight, as `MoodLoop`. `rest`
/// is the one it starts and rests in; when faces should move often it rests
/// there half as long. A spell never follows itself.
struct MoodLoop {
	let rest: MoodSpell
	let others: [MoodSpell]

	/// Moves through the loop until cancelled, showing each mood as its spell starts, as `useMoodLoop`.
	@MainActor func run(liveliness: Liveliness, show: (BotMood) -> Void) async {
		let spells = [rest] + others
		var current = 0
		while !Task.isCancelled {
			show(spells[current].mood)
			let share = current == 0 && liveliness == .often ? FaceMotion.oftenRestShare : 1
			guard (try? await Task.sleep(for: .seconds(spells[current].seconds.random() * share))) != nil else { return }
			current = Self.next(after: current, in: spells)
		}
	}

	/// A spell other than `current`, chosen at random by weight.
	private static func next(after current: Int, in spells: [MoodSpell]) -> Int {
		let others = spells.indices.filter { $0 != current }
		var roll = Double.random(in: 0 ..< 1) * others.map { spells[$0].weight }.reduce(0, +)
		for index in others {
			roll -= spells[index].weight
			if roll <= 0 { return index }
		}
		return others.last ?? current
	}
}

/// One stretch of a mood in a loop: how likely it is to come next, and how long it lasts.
struct MoodSpell {
	let mood: BotMood
	let weight: Double
	let seconds: Span
}

/// How the faces in a group take turns to move, as `GroupPacing`.
struct GroupPacing {
	/// How many faces may move at once.
	let movingAtOnce: Int
	/// Seconds between turns starting, and how long a turn lasts.
	let gapSeconds: Span
	let turnSeconds: Span
}
