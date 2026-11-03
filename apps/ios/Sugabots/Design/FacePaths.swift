import Foundation

/*
 * How a lively face's parts move, as `layer-motion.ts` moves the web's: each
 * part rests somewhere and moves along paths, springs and keyframes, whose
 * changes fall on the ticks of one clock shared by every face. The paths are
 * worked out from the time alone, so a face is drawn by asking where each
 * part is at the clock's latest tick.
 */

/// A span from `least` to `most`, of seconds or a size, that something is picked from at random, as `Span`.
struct Span {
	let least: Double
	let most: Double

	/// A number picked at random, evenly, from the span, as `randomIn`.
	func random() -> Double {
		least + Double.random(in: 0 ..< 1) * (most - least)
	}
}

/// A spring's physics, as motion's `spring` takes them; it rests once within
/// `restDelta` of where it's going and slower than `restSpeed`, or motion's
/// defaults for how far it goes when not given.
struct SpringTuning {
	let stiffness: Double
	let damping: Double
	var restDelta: Double?
	var restSpeed: Double?
}

/// How a keyframe eases into the next, as motion's named easings.
enum Easing {
	case linear, easeIn, easeOut, easeInOut

	func callAsFunction(_ progress: Double) -> Double {
		switch self {
		case .linear: progress
		case .easeIn: Self.cubicBezier(0.42, 0, 1, 1, at: progress)
		case .easeOut: Self.cubicBezier(0, 0, 0.58, 1, at: progress)
		case .easeInOut: Self.cubicBezier(0.42, 0, 0.58, 1, at: progress)
		}
	}

	/// A CSS cubic Bézier's progress at `x`, found by halving as motion's `cubicBezier` does.
	private static func cubicBezier(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, at x: Double) -> Double {
		if x <= 0 { return 0 }
		if x >= 1 { return 1 }
		func along(_ t: Double, _ first: Double, _ second: Double) -> Double {
			(((1 - 3 * second + 3 * first) * t + (3 * second - 6 * first)) * t + 3 * first) * t
		}
		var lower = 0.0
		var upper = 1.0
		var t = 0.5
		for _ in 0 ..< Self.subdivisions {
			t = lower + (upper - lower) / 2
			let error = along(t, x1, x2) - x
			if abs(error) <= Self.subdivisionPrecision { break }
			if error > 0 { upper = t } else { lower = t }
		}
		return along(t, y1, y2)
	}

	private static let subdivisions = 12
	private static let subdivisionPrecision = 0.0000001
}

/// Values passing through `frames` at `times` (shares of `seconds`, from 0 to 1), eased between each pair by `ease`.
struct Keyframes {
	let frames: [[Double]]
	let times: [Double]
	let ease: [Easing]
	let seconds: Double
}

/// A way of getting from one set of values to another, as `Path`. A keyframes
/// path's first frame is replaced by wherever the part is when it starts.
enum FacePath {
	case spring(to: [Double], SpringTuning)
	case keyframes(Keyframes)
}

/// Values over time, from 0 to `seconds`, where they stay.
struct Timeline {
	let seconds: Double
	let valuesAt: (Double) -> [Double]

	/// Paths one after another, each from where the last ends; the first starts at `velocity`, where it's a spring, as `sequence`.
	static func of(_ paths: [FacePath], from start: [Double], velocity: [Double]? = nil) -> Timeline {
		var parts: [(startsAt: Double, timeline: Timeline)] = []
		var from = start
		var total = 0.0
		for (index, path) in paths.enumerated() {
			let part = Timeline(path, from: from, velocity: index == 0 ? velocity : nil)
			parts.append((total, part))
			total += part.seconds
			from = part.valuesAt(part.seconds)
		}
		return Timeline(seconds: total) { time in
			guard let part = parts.last(where: { time >= $0.startsAt }) ?? parts.first else { return start }
			return part.timeline.valuesAt(min(time - part.startsAt, part.timeline.seconds))
		}
	}

	/// One path from `from`, moving at `velocity` per second where it's a spring, as `pathFrom`.
	init(_ path: FacePath, from: [Double], velocity: [Double]?) {
		switch path {
		case let .spring(to, tuning):
			// One spring for each value, so each carries on at the speed it was moving.
			let springs = from.enumerated().map { index, value in
				SpringCurve(from: value, to: index < to.count ? to[index] : value, velocity: velocity.map { index < $0.count ? $0[index] : 0 } ?? 0, tuning: tuning)
			}
			let seconds = springs.map(\.settlingSeconds).max() ?? 0
			self.init(seconds: seconds) { time in
				springs.map { time >= seconds ? $0.to : $0.value(at: max(0, time)) }
			}
		case let .keyframes(keyframes):
			let frames = [from] + keyframes.frames.dropFirst()
			let moments = keyframes.times.map { $0 * keyframes.seconds }
			self.init(seconds: keyframes.seconds) { time in
				Self.interpolate(frames, at: moments, easing: keyframes.ease, time: time)
			}
		}
	}

	init(seconds: Double, valuesAt: @escaping (Double) -> [Double]) {
		self.seconds = seconds
		self.valuesAt = valuesAt
	}

	/// Where `frames` have got to at `time`, held at the first before it starts and the last after, as motion's `interpolate`.
	private static func interpolate(_ frames: [[Double]], at moments: [Double], easing: [Easing], time: Double) -> [Double] {
		guard let first = frames.first, let last = frames.last else { return [] }
		if time <= moments.first ?? 0 { return first }
		guard let segment = moments.indices.dropLast().last(where: { moments[$0] <= time }), segment + 1 < frames.count, time < moments[segment + 1] else { return last }
		let span = moments[segment + 1] - moments[segment]
		let progress = span > 0 ? (time - moments[segment]) / span : 1
		let eased = (segment < easing.count ? easing[segment] : .linear)(progress)
		let start = frames[segment]
		let end = frames[segment + 1]
		return start.indices.map { index in
			let to = index < end.count ? end[index] : start[index]
			return start[index] + (to - start[index]) * eased
		}
	}
}

/// One value springing from `from` to `to`, as motion's `spring` generator,
/// in seconds rather than its milliseconds.
private struct SpringCurve {
	let from: Double
	let to: Double
	let velocity: Double
	let tuning: SpringTuning

	/// What's taken as close enough and slow enough to rest, as motion picks for a change this large when not told.
	private var restDelta: Double { tuning.restDelta ?? (abs(to - from) < Self.granularScale ? 0.005 : 0.5) }
	private var restSpeed: Double { tuning.restSpeed ?? (abs(to - from) < Self.granularScale ? 0.01 : 2) }
	/// Below this change motion counts a spring as fine-grained, and rests it sooner.
	private static let granularScale = 5.0

	private var undampedFrequency: Double { tuning.stiffness.squareRoot() }
	private var dampingRatio: Double { tuning.damping / (2 * tuning.stiffness.squareRoot()) }

	func value(at time: Double) -> Double {
		let delta = to - from
		// Motion's springs count velocity towards the start, hence the sign.
		let startSpeed = -velocity
		let frequency = undampedFrequency
		let ratio = dampingRatio
		let decay = ratio * frequency
		if ratio < 1 {
			let angular = frequency * (1 - ratio * ratio).squareRoot()
			let envelope = exp(-decay * time)
			return to - envelope * ((startSpeed + decay * delta) / angular * sin(angular * time) + delta * cos(angular * time))
		}
		if ratio == 1 {
			return to - exp(-frequency * time) * (delta + (startSpeed + frequency * delta) * time)
		}
		let damped = frequency * (ratio * ratio - 1).squareRoot()
		let envelope = exp(-decay * time)
		let turned = min(damped * time, Self.hyperbolicLimit)
		return to - envelope * ((startSpeed + decay * delta) * sinh(turned) + damped * delta * cosh(turned)) / damped
	}

	/// Where sinh and cosh are capped, as motion caps them, so they never overflow.
	private static let hyperbolicLimit = 300.0

	/// How long it takes to rest, stepped through as `layer-motion.ts` does, and cut off at the longest a spring may run.
	var settlingSeconds: Double {
		var time = 0.0
		while time < FaceMotion.longestSpringSeconds {
			if isResting(at: time) { return time }
			time += FaceMotion.springSettleStepSeconds
		}
		return FaceMotion.longestSpringSeconds
	}

	private func isResting(at time: Double) -> Bool {
		let step = 0.0001
		let speed = time == 0 ? velocity : (value(at: time + step) - value(at: max(0, time - step))) / (time + step - max(0, time - step))
		return abs(speed) <= restSpeed && abs(to - value(at: time)) <= restDelta
	}
}

/// The one clock every lively face's moves fall on, as `layer-motion.ts`'s:
/// ticks counted from the same moment for every face, so faces moving at once
/// change together, and no more often than a video's frames.
enum FaceClock {
	/// Now, in seconds, as every face's paths are timed.
	static func now() -> Double {
		Date.now.timeIntervalSinceReferenceDate
	}

	/// The latest tick at or before `date`.
	static func tick(at date: Date) -> Double {
		(date.timeIntervalSinceReferenceDate / FaceMotion.tickSeconds).rounded(.down) * FaceMotion.tickSeconds
	}

	/// The first tick at or after `time`.
	static func tick(from time: Double) -> Double {
		(time / FaceMotion.tickSeconds).rounded(.up) * FaceMotion.tickSeconds
	}

	/// `seconds` rounded up to a whole number of ticks, so a repeating path stays on the clock.
	static func wholeTicks(_ seconds: Double) -> Double {
		max(1, (seconds / FaceMotion.tickSeconds - Self.tickTolerance).rounded(.up)) * FaceMotion.tickSeconds
	}

	/// How far under a whole number of ticks a length may fall and still count as it, against rounding error.
	private static let tickTolerance = 0.000001
}

/// One of a face's moving parts, as `LayerMotion`: values resting somewhere,
/// moving along paths started on the clock's ticks.
struct FaceTrack {
	let rest: [Double]
	private var held: [Double]
	private var playing: Playing?

	init(rest: [Double]) {
		self.rest = rest
		held = rest
	}

	/// What's under way: perhaps a lead-in once, and then a timeline, once or again and again.
	private struct Playing {
		var leadIn: (startsAt: Double, timeline: Timeline)?
		let startsAt: Double
		let timeline: Timeline
		let repeats: Bool

		/// When it comes to rest; never, while it repeats.
		var endsAt: Double {
			repeats ? .infinity : startsAt + timeline.seconds
		}

		func values(at time: Double) -> [Double] {
			if let leadIn, time < startsAt {
				return leadIn.timeline.valuesAt(min(max(0, time - leadIn.startsAt), leadIn.timeline.seconds))
			}
			var elapsed = max(0, time - startsAt)
			if repeats { elapsed = elapsed.isFinite ? elapsed.truncatingRemainder(dividingBy: timeline.seconds) : 0 }
			return timeline.valuesAt(min(elapsed, timeline.seconds))
		}
	}

	/// When the part comes to rest: never while it repeats, and already when nothing is under way.
	var endsAt: Double {
		playing?.endsAt ?? -.infinity
	}

	func values(at time: Double) -> [Double] {
		playing?.values(at: time) ?? held
	}

	/// How fast each value is changing at `time`, per second, so a new spring carries on at the same speed.
	private func velocity(at time: Double) -> [Double] {
		guard let playing else { return held.map { _ in 0 } }
		let before = playing.values(at: time)
		let after = playing.values(at: min(time + FaceMotion.velocitySeconds, playing.endsAt))
		return before.indices.map { index in ((index < after.count ? after[index] : before[index]) - before[index]) / FaceMotion.velocitySeconds }
	}

	/// Sets the part straight to `values`, with nothing under way.
	mutating func jump(to values: [Double]) {
		playing = nil
		held = values
	}

	/// Stops where it is at `time`, holding that pose.
	mutating func stop(at time: Double) {
		held = values(at: time)
		playing = nil
	}

	/// Plays `paths` one after another from wherever the part is at `time`
	/// (or from `start`, when given), at the speed it's moving: again and again
	/// if `repeating`, after `delaySeconds`. A repeating path first eases to
	/// where it starts, so each time round begins from the same place.
	mutating func play(_ paths: [FacePath], at time: Double, repeating: Bool = false, delaySeconds: Double = 0, from start: [Double]? = nil) {
		let from = start ?? values(at: time)
		let velocity = start == nil ? velocity(at: time) : nil
		let startsAt = FaceClock.tick(from: time)
		if repeating, case let .keyframes(first)? = paths.first, let loopStart = first.frames.first, Self.apart(from, loopStart) {
			let leadIn = Timeline.of([.keyframes(Keyframes(frames: [from, loopStart], times: [0, 1], ease: [.easeInOut], seconds: FaceMotion.leadInSeconds))], from: from)
			let leadInEnds = startsAt + FaceClock.wholeTicks(leadIn.seconds)
			playing = Playing(
				leadIn: (startsAt, leadIn),
				startsAt: FaceClock.tick(from: leadInEnds + delaySeconds),
				timeline: Self.onTicks(Timeline.of(paths, from: loopStart)),
				repeats: true
			)
			return
		}
		playing = Playing(startsAt: FaceClock.tick(from: time + delaySeconds), timeline: Self.onTicks(Timeline.of(paths, from: from, velocity: velocity)), repeats: repeating)
	}

	/// A timeline a whole number of ticks long, holding its end for the rest.
	private static func onTicks(_ timeline: Timeline) -> Timeline {
		Timeline(seconds: FaceClock.wholeTicks(timeline.seconds)) { timeline.valuesAt(min($0, timeline.seconds)) }
	}

	/// Whether two poses differ by more than rounding.
	private static func apart(_ left: [Double], _ right: [Double]) -> Bool {
		zip(left, right).contains { abs($0 - $1) > samePoseTolerance }
	}

	private static let samePoseTolerance = 0.0001
}
