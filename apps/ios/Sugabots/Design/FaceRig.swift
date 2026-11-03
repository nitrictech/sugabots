import CoreGraphics
import Foundation
import Observation

/// Where the eyes look, from -1 to 1 on each axis, as a mood's `gaze`.
struct Gaze {
	let x: Double
	let y: Double
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
 * are generated. The chances below are those functions' own.
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
		case .sleepy: if Double.random(in: 0 ..< 1) < 0.5 { face.flutter() }
		case .still, .thinking: break
		}
	}

	/// Blinks now and then; otherwise glances somewhere new, unless it's watching typing.
	@MainActor private func glanceOrBlink(_ face: FaceRig) {
		if face.isWatching || Double.random(in: 0 ..< 1) < 0.3 {
			face.blink(twice: Double.random(in: 0 ..< 1) < 0.2)
			return
		}
		// Back to straight ahead about a third of the time, else somewhere new.
		let gaze = Double.random(in: 0 ..< 1) < 0.35 ? Gaze(x: 0, y: 0) : Self.randomGlance(reach: 1)
		// People blink as their eyes shift a long way.
		if face.look(at: gaze) > 0.6, Double.random(in: 0 ..< 1) < 0.5 { face.blink() }
	}

	@MainActor private func bounceOrBlink(_ face: FaceRig) {
		let roll = Double.random(in: 0 ..< 1)
		if roll < 0.45 {
			face.hop(size: FaceMotion.happyBounce)
		} else if roll < 0.7 {
			face.blink()
		} else if !face.isWatching {
			// Small glances only: it keeps its face towards you.
			face.look(at: Self.randomGlance(reach: 0.4))
		}
	}

	@MainActor private func bounceOrHop(_ face: FaceRig) {
		// Never cuts a hop short in the air.
		guard !face.isAirborne else { return }
		face.hop(size: Double.random(in: 0 ..< 1) < FaceMotion.excitedFullHopChance ? 1 : FaceMotion.excitedBounce.random())
	}

	/// Somewhere to glance, up to `reach` from straight ahead: any direction, at least halfway out, more sideways than up or down.
	private static func randomGlance(reach: Double) -> Gaze {
		let angle = Double.random(in: 0 ..< 1) * .pi * 2
		let distance = (0.5 + Double.random(in: 0 ..< 1) * 0.5) * reach
		return Gaze(x: cos(angle) * distance, y: sin(angle) * distance * 0.6)
	}
}

/// Where each of a face's parts is at one moment, which is all it takes to draw it.
/// Translations are percentages of the face, as the web's layers move.
struct FacePose {
	var hopRise = 0.0
	var hopSquash = (width: 1.0, height: 1.0)
	var gazeMove = (x: 0.0, y: 0.0)
	var moodMove = 0.0
	var wiggleMove = 0.0
	var gazeTiltDegrees = 0.0
	var moodTiltDegrees = 0.0
	var wiggleTiltDegrees = 0.0
	var hopEyesDrop = 0.0
	var eyesLift = 0.0
	var eyesGaze = (x: 0.0, y: 0.0, width: 1.0)
	/// Each thinking dot's rise, as a share of its height, and brightness.
	var dots: [(rise: Double, opacity: Double)] = []
	/// How tall an open eye is drawn, before the shut-eye minimum.
	var eyeHeight = 1.0
	var eyesShrink = 1.0
	var smile = 0.0
	var arcsFlat = 0.0
	var outerDotsGrow = 0.0
	var middleDotGrows = 0.0
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

	@ObservationIgnored private var parts: [Part: FaceTrack] = Dictionary(uniqueKeysWithValues: Part.allCases.map { ($0, FaceTrack(rest: $0.rest)) })
	@ObservationIgnored private var settling: Task<Void, Never>?
	@ObservationIgnored private var gaze = Gaze(x: 0, y: 0)
	@ObservationIgnored private var watchedAt = -Double.infinity
	@ObservationIgnored private var landsAt = 0.0
	@ObservationIgnored private var heldLook: MoodLook?
	@ObservationIgnored private var stopGoingOn: (() -> Void)?
	@ObservationIgnored private var acting: Task<Void, Never>?
	@ObservationIgnored private var lastJumpToTyping = -Double.infinity
	@ObservationIgnored private var jumpingToTyping: Task<Void, Never>?
	@ObservationIgnored private var typingTarget: (point: CGPoint, face: CGRect)?

	/// The face's parts, as the web's layers and the values its eyes are drawn with.
	private enum Part: Hashable, CaseIterable {
		case hopRise, hopSquash, gazeMove, moodMove, wiggleMove, gazeTilt, moodTilt, wiggleTilt
		case hopEyesDrop, eyesLift, eyesGaze, leftDot, middleDot, rightDot
		case blink, flutter, eyesOpen, smile, arcsFlat, dots

		var rest: [Double] {
			switch self {
			case .hopSquash: [1, 1]
			case .gazeMove: [0, 0]
			case .eyesGaze: [0, 0, 1]
			case .leftDot, .middleDot, .rightDot: FaceMotion.dotRest
			case .blink, .eyesOpen: [1]
			case .hopRise, .moodMove, .wiggleMove, .gazeTilt, .moodTilt, .wiggleTilt, .hopEyesDrop, .eyesLift, .flutter, .smile, .arcsFlat, .dots: [0]
			}
		}

		static let thinkingDots: [Part] = [.leftDot, .middleDot, .rightDot]
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

	/// Stops everything where it is, as the face goes.
	func stopAll() {
		leaveMood()
		jumpingToTyping?.cancel()
		let now = FaceClock.now()
		for part in Part.allCases { parts[part]?.stop(at: now) }
		changed()
	}

	/// Holds the head and eyes as `look` says: eased there gently when the
	/// look changes, and set straight away the first time.
	private func hold(_ look: MoodLook) {
		let first = heldLook == nil
		guard heldLook != look else { return }
		heldLook = look
		let poses: [(Part, [Double], SpringTuning)] = [
			(.moodMove, [Self.percent(look.headDrop)], FaceMotion.moodSpring),
			(.moodTilt, [look.headLean], FaceMotion.moodSpring),
			(.eyesLift, [Self.percent(look.eyesLift)], FaceMotion.moodSpring),
			(.eyesOpen, [look.eyesOpen], FaceMotion.eyeShapeMoodSpring),
			(.smile, [look.smile], FaceMotion.eyeShapeMoodSpring),
			(.arcsFlat, [look.arcsFlat], FaceMotion.eyeShapeMoodSpring),
			(.dots, [look.dots], FaceMotion.eyeShapeMoodSpring),
		]
		for (part, pose, spring) in poses {
			if first { parts[part]?.jump(to: pose) } else { play(part, [.spring(to: pose, spring)]) }
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
		play(.eyesGaze, [.spring(to: eyes, FaceMotion.eyesSpring)])
		play(.gazeMove, [.spring(to: [Self.percent(target.x * FaceMotion.headTravelX), Self.percent(target.y * FaceMotion.headTravelY)], FaceMotion.headSpring)])
		play(.gazeTilt, [.spring(to: [target.x * FaceMotion.headTiltDegrees], FaceMotion.headSpring)])
		changed()
		return distance
	}

	/// Whether the eyes have been on typing lately, which idle glances then leave alone.
	var isWatching: Bool {
		FaceClock.now() - watchedAt < FaceMotion.watchingRestSeconds
	}

	func blink(twice: Bool = false) {
		let closed = FaceMotion.blinkClosed
		let once = FacePath.keyframes(Keyframes(frames: [[1], [closed], [closed], [1]], times: FaceMotion.blinkTimes, ease: Array(repeating: .easeInOut, count: 3), seconds: FaceMotion.blinkSeconds))
		let gap = FacePath.keyframes(Keyframes(frames: [[1], [1]], times: [0, 1], ease: [.linear], seconds: FaceMotion.blinkTwiceGapSeconds))
		play(.blink, twice ? [once, gap, once] : [once], from: [1])
		changed()
	}

	/// A hop `size` times as big as a full one; a new hop takes over from one in the air.
	func hop(size: Double = 1) {
		landsAt = FaceClock.now() + FaceMotion.hopSeconds
		play(.hopRise, [.keyframes(Self.scaled(FaceMotion.hopRise, by: size, from: [0]))])
		play(.hopSquash, [.keyframes(Self.scaled(FaceMotion.hopSquash, by: size, from: [1, 1])), .spring(to: [1, 1], FaceMotion.hopSquashSettle)])
		play(.hopEyesDrop, [.keyframes(Self.scaled(FaceMotion.hopEyesDrop, by: size, from: [0])), .spring(to: [0], FaceMotion.hopEyesDropSettle)])
		changed()
	}

	var isAirborne: Bool {
		FaceClock.now() < landsAt
	}

	/// Wiggles the head from side to side until the returned function eases it still.
	func wiggle() -> () -> Void {
		let swing = { (part: Part, reach: Double) in
			let sway = Keyframes(frames: FaceMotion.wiggleSides.map { [$0 * reach] }, times: FaceMotion.wiggleTimes, ease: Array(repeating: .easeInOut, count: FaceMotion.wiggleSides.count - 1), seconds: FaceMotion.wiggleSeconds)
			self.play(part, [.keyframes(sway)], repeating: true)
		}
		swing(.wiggleMove, Self.percent(FaceMotion.wiggleShift))
		swing(.wiggleTilt, FaceMotion.wiggleDegrees)
		changed()
		return { [weak self] in
			self?.easeToRest([.wiggleMove, .wiggleTilt])
		}
	}

	/// Raises the thinking dots in turn until the returned function settles them.
	func riseDots() -> () -> Void {
		let resting = FaceMotion.dotRest
		let risen = [FaceMotion.dotRiseShare, FaceMotion.dotBrightest]
		let rise = Keyframes(frames: [resting, risen, resting, resting], times: FaceMotion.dotRiseTimes, ease: Array(repeating: .easeInOut, count: FaceMotion.dotRiseTimes.count - 1), seconds: FaceMotion.dotCycleSeconds)
		for (index, dot) in Part.thinkingDots.enumerated() {
			play(dot, [.keyframes(rise)], repeating: true, delaySeconds: Double(index) * FaceMotion.dotStaggerSeconds)
		}
		changed()
		return { [weak self] in
			self?.easeToRest(Part.thinkingDots)
		}
	}

	/// Opens the eyes half way for a moment, however shut its mood holds them.
	func flutter() {
		let open = Keyframes(frames: [[0], [FaceMotion.flutterOpen], [0]], times: FaceMotion.flutterTimes, ease: FaceMotion.flutterEase, seconds: FaceMotion.flutterSeconds)
		play(.flutter, [.keyframes(open)], from: [0])
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
		func values(_ part: Part) -> [Double] { parts[part]?.values(at: time) ?? part.rest }
		func value(_ part: Part) -> Double { values(part).first ?? 0 }
		let squash = values(.hopSquash)
		let gazeMove = values(.gazeMove)
		let eyesGaze = values(.eyesGaze)
		let dots = value(.dots)
		return FacePose(
			hopRise: value(.hopRise),
			hopSquash: (squash[0], squash[1]),
			gazeMove: (gazeMove[0], gazeMove[1]),
			moodMove: value(.moodMove),
			wiggleMove: value(.wiggleMove),
			gazeTiltDegrees: value(.gazeTilt),
			moodTiltDegrees: value(.moodTilt),
			wiggleTiltDegrees: value(.wiggleTilt),
			hopEyesDrop: value(.hopEyesDrop),
			eyesLift: value(.eyesLift),
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
			outerDotsGrow: Self.share(of: dots, across: FaceMotion.outerDotsGrow),
			middleDotGrows: Self.share(of: dots, across: FaceMotion.middleDotGrows)
		)
	}

	// MARK: Parts

	private func play(_ part: Part, _ paths: [FacePath], repeating: Bool = false, delaySeconds: Double = 0, from start: [Double]? = nil) {
		parts[part]?.play(paths, at: FaceClock.now(), repeating: repeating, delaySeconds: delaySeconds, from: start)
	}

	/// Eases parts back to rest.
	private func easeToRest(_ resting: [Part]) {
		for part in resting {
			let rest = part.rest
			play(part, [.keyframes(Keyframes(frames: [rest, rest], times: [0, 1], ease: [.easeOut], seconds: FaceMotion.stillingSeconds))])
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
		units / FaceDrawing.viewboxSize * 100
	}

	/// How far `value` is across `range`, from 0 to 1, as motion's `useTransform` maps it.
	private static func share(of value: Double, across range: [Double]) -> Double {
		guard range.count == 2, range[1] != range[0] else { return value }
		return min(1, max(0, (value - range[0]) / (range[1] - range[0])))
	}

	/// A full hop's keyframes made `size` times as big, about `rest`, as `hopPaths` makes them.
	private static func scaled(_ keyframes: Keyframes, by size: Double, from rest: [Double]) -> Keyframes {
		Keyframes(
			frames: keyframes.frames.map { frame in frame.indices.map { rest[$0] + (frame[$0] - rest[$0]) * size } },
			times: keyframes.times,
			ease: keyframes.ease,
			seconds: keyframes.seconds
		)
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
