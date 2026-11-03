import SwiftUI

/// A Lucide icon as the web draws it: stroked in the current foreground
/// style, its stroke scaling with its size, as `lucide-react`'s does.
struct Icon: View {
	let icon: Lucide
	var size: CGFloat = 16
	/// In the icon's own 24-point square, as `strokeWidth` is on the web.
	var strokeWidth: CGFloat = 2

	init(_ icon: Lucide, size: CGFloat = 16, strokeWidth: CGFloat = 2) {
		self.icon = icon
		self.size = size
		self.strokeWidth = strokeWidth
	}

	var body: some View {
		IconShape(icon: icon)
			.stroke(style: StrokeStyle(lineWidth: strokeWidth * size / 24, lineCap: .round, lineJoin: .round))
			.frame(width: size, height: size)
			.accessibilityHidden(true)
	}
}

private struct IconShape: Shape {
	let icon: Lucide

	func path(in rect: CGRect) -> Path {
		IconPaths.shared.path(icon).applying(
			CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: rect.width / 24, y: rect.height / 24)
		)
	}
}

/// Each icon's path on its 24-point square, parsed once. SwiftUI may ask for
/// a shape's path off the main thread, so the cache takes a lock.
private final class IconPaths: @unchecked Sendable {
	static let shared = IconPaths()

	private var paths: [Lucide: Path] = [:]
	private let lock = NSLock()

	func path(_ icon: Lucide) -> Path {
		lock.lock()
		defer { lock.unlock() }
		if let path = paths[icon] { return path }
		var path = Path()
		for data in icon.paths { path.addPath(SVGPath.path(data)) }
		paths[icon] = path
		return path
	}
}
