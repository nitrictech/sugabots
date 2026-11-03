import SwiftUI

/// Path data in the SVG syntax `@sugabots/avatars` writes its heads and eyes
/// in: move, line, horizontal, vertical, cubic, smooth cubic, quadratic, arc
/// and close, absolute and relative.
enum SVGPath {
	static func path(_ data: String) -> Path {
		var path = Path()
		var reader = Reader(data)
		var current = CGPoint.zero
		var start = CGPoint.zero
		var lastControl: CGPoint?
		var command: Character = "M"

		while let next = reader.nextCommand(continuing: command) {
			command = next
			let relative = command.isLowercase
			let origin = relative ? current : .zero
			func point() -> CGPoint? {
				guard let x = reader.number(), let y = reader.number() else { return nil }
				return CGPoint(x: origin.x + x, y: origin.y + y)
			}
			var control: CGPoint?

			switch command.uppercased() {
			case "M":
				guard let to = point() else { return path }
				path.move(to: to)
				current = to
				start = to
				// Pairs after a move's first are lines.
				command = relative ? "l" : "L"
			case "L":
				guard let to = point() else { return path }
				path.addLine(to: to)
				current = to
			case "H":
				guard let x = reader.number() else { return path }
				current = CGPoint(x: (relative ? current.x : 0) + x, y: current.y)
				path.addLine(to: current)
			case "V":
				guard let y = reader.number() else { return path }
				current = CGPoint(x: current.x, y: (relative ? current.y : 0) + y)
				path.addLine(to: current)
			case "C":
				guard let first = point(), let second = point(), let to = point() else { return path }
				path.addCurve(to: to, control1: first, control2: second)
				control = second
				current = to
			case "S":
				let first = reflected(lastControl, about: current)
				guard let second = point(), let to = point() else { return path }
				path.addCurve(to: to, control1: first, control2: second)
				control = second
				current = to
			case "Q":
				guard let middle = point(), let to = point() else { return path }
				path.addQuadCurve(to: to, control: middle)
				current = to
			case "A":
				guard
					let rx = reader.number(), let ry = reader.number(), let rotation = reader.number(),
					let large = reader.flag(), let sweep = reader.flag(), let to = point()
				else { return path }
				addArc(to: &path, from: current, to: to, radii: CGSize(width: rx, height: ry),
				       rotationDegrees: rotation, largeArc: large, sweep: sweep)
				current = to
			case "Z":
				path.closeSubpath()
				current = start
			default:
				return path
			}
			lastControl = control
		}
		return path
	}

	private static func reflected(_ control: CGPoint?, about point: CGPoint) -> CGPoint {
		guard let control else { return point }
		return CGPoint(x: 2 * point.x - control.x, y: 2 * point.y - control.y)
	}

	/// An elliptical arc as cubic curves, by the endpoint-to-centre conversion in SVG's implementation notes.
	private static func addArc(
		to path: inout Path, from start: CGPoint, to end: CGPoint, radii: CGSize,
		rotationDegrees: Double, largeArc: Bool, sweep: Bool
	) {
		var rx = abs(radii.width)
		var ry = abs(radii.height)
		guard rx > 0, ry > 0, start != end else {
			path.addLine(to: end)
			return
		}
		let phi = rotationDegrees * .pi / 180
		let cosPhi = cos(phi)
		let sinPhi = sin(phi)
		let dx = (start.x - end.x) / 2
		let dy = (start.y - end.y) / 2
		let x1 = cosPhi * dx + sinPhi * dy
		let y1 = -sinPhi * dx + cosPhi * dy

		let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
		if lambda > 1 {
			rx *= lambda.squareRoot()
			ry *= lambda.squareRoot()
		}
		let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
		let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
		let coefficient = (largeArc == sweep ? -1 : 1) * max(0, numerator / denominator).squareRoot()
		let cx1 = coefficient * rx * y1 / ry
		let cy1 = coefficient * -ry * x1 / rx
		let centre = CGPoint(
			x: cosPhi * cx1 - sinPhi * cy1 + (start.x + end.x) / 2,
			y: sinPhi * cx1 + cosPhi * cy1 + (start.y + end.y) / 2
		)

		func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
			let sign: Double = ux * vy - uy * vx < 0 ? -1 : 1
			let dot = (ux * vx + uy * vy) / ((ux * ux + uy * uy).squareRoot() * (vx * vx + vy * vy).squareRoot())
			return sign * acos(min(1, max(-1, dot)))
		}
		let theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
		var delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
		if !sweep, delta > 0 { delta -= 2 * .pi }
		if sweep, delta < 0 { delta += 2 * .pi }

		let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
		let step = delta / Double(segments)
		let handle = 4 / 3 * tan(step / 4)
		let centreX = Double(centre.x)
		let centreY = Double(centre.y)
		func onEllipse(_ t: Double) -> CGPoint {
			let along = rx * cos(t)
			let across = ry * sin(t)
			return CGPoint(x: centreX + along * cosPhi - across * sinPhi, y: centreY + along * sinPhi + across * cosPhi)
		}
		func derivative(_ t: Double) -> CGPoint {
			let along = -rx * sin(t)
			let across = ry * cos(t)
			return CGPoint(x: along * cosPhi - across * sinPhi, y: along * sinPhi + across * cosPhi)
		}
		var t = theta
		for _ in 0..<segments {
			let from = onEllipse(t)
			let to = onEllipse(t + step)
			let fromSlope = derivative(t)
			let toSlope = derivative(t + step)
			path.addCurve(
				to: to,
				control1: CGPoint(x: from.x + handle * fromSlope.x, y: from.y + handle * fromSlope.y),
				control2: CGPoint(x: to.x - handle * toSlope.x, y: to.y - handle * toSlope.y)
			)
			t += step
		}
	}

	/// Reads commands, numbers and arc flags from path data, which may run them together: `a5.33 5.33 0 0 1-10.67 0`.
	private struct Reader {
		private let characters: [Character]
		private var index = 0

		init(_ data: String) {
			characters = Array(data)
		}

		/// The next command letter, or `continuing` when numbers follow without one.
		mutating func nextCommand(continuing: Character) -> Character? {
			skipSeparators()
			guard index < characters.count else { return nil }
			let character = characters[index]
			if character.isLetter {
				index += 1
				return character
			}
			return continuing
		}

		mutating func flag() -> Bool? {
			skipSeparators()
			guard index < characters.count, characters[index] == "0" || characters[index] == "1" else { return nil }
			defer { index += 1 }
			return characters[index] == "1"
		}

		mutating func number() -> Double? {
			skipSeparators()
			var text = ""
			var seenDot = false
			var seenExponent = false
			while index < characters.count {
				let character = characters[index]
				if character == "-" || character == "+" {
					guard text.isEmpty || text.last == "e" || text.last == "E" else { break }
				} else if character == "." {
					guard !seenDot, !seenExponent else { break }
					seenDot = true
				} else if character == "e" || character == "E" {
					guard !seenExponent, !text.isEmpty else { break }
					seenExponent = true
				} else if !character.isNumber {
					break
				}
				text.append(character)
				index += 1
			}
			return Double(text)
		}

		private mutating func skipSeparators() {
			while index < characters.count, characters[index] == " " || characters[index] == "," {
				index += 1
			}
		}
	}
}
