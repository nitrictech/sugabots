import SwiftUI

/// A sheet a settings page can open of its own for a screenshot, named by
/// `SUGABOTS_SHEET` in a development build's launch environment.
@MainActor
enum DebugSheet: String {
	case timeZone = "timezone"
	case invite
	case look
	case addConnection = "addconnection"

	/// Whether `SUGABOTS_SHEET` names this sheet and it hasn't been opened yet,
	/// so a page opens it the first time it appears. Always false outside
	/// development builds.
	var isWanted: Bool {
		#if DEBUG
		DebugLaunch.once("SUGABOTS_SHEET", is: rawValue)
		#else
		false
		#endif
	}
}
