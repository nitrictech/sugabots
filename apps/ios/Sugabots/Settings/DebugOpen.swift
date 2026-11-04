import SwiftUI

/// Whether `SUGABOTS_SHEET` names `sheet`, so a page opens that sheet of its
/// own for a screenshot the first time it appears. Always false outside
/// development builds.
@MainActor
enum DebugSheet {
	static func wants(_ sheet: String) -> Bool {
		#if DEBUG
		DebugLaunch.once("SUGABOTS_SHEET", is: sheet)
		#else
		false
		#endif
	}
}
