import Foundation

/// A time zone as the picker lists it: its place, its identifier, and its offset now.
struct TimeZoneChoice: Hashable {
	let zone: String
	let place: String
	let offset: String

	/// Every zone the device knows, with UTC among them, as `timeZoneChoices`.
	static func all(at now: Date) -> [TimeZoneChoice] {
		let zones = TimeZone.knownTimeZoneIdentifiers
		let named = zones.contains("UTC") ? zones : ["UTC"] + zones
		return named.map { zone in
			TimeZoneChoice(zone: zone, place: place(of: zone), offset: offset(of: zone, at: now))
		}
	}

	/// As `timeZonePlace`: `America/New_York` is `New York`.
	static func place(of zone: String) -> String {
		(zone.split(separator: "/").last.map(String.init) ?? zone).replacingOccurrences(of: "_", with: " ")
	}

	/// `UTC+10`, `UTC-3:30`, or `UTC`, as the web's short offset reads.
	static func offset(of zone: String, at now: Date) -> String {
		guard let seconds = TimeZone(identifier: zone)?.secondsFromGMT(for: now) else { return "" }
		if seconds == 0 { return "UTC" }
		let minutes = abs(seconds) / 60
		let sign = seconds < 0 ? "-" : "+"
		return minutes % 60 == 0 ? "UTC\(sign)\(minutes / 60)" : String(format: "UTC%@%d:%02d", sign, minutes / 60, minutes % 60)
	}

	func matches(_ needle: String) -> Bool {
		needle.isEmpty || zone.lowercased().replacingOccurrences(of: "_", with: " ").contains(needle) || offset.lowercased().contains(needle)
	}
}

/// The zones under one part of the world, as `timeZoneRegions` groups them.
struct TimeZoneRegion: Hashable {
	let name: String
	let choices: [TimeZoneChoice]

	static func of(_ choices: [TimeZoneChoice]) -> [TimeZoneRegion] {
		let byPlace = choices.sorted { $0.place.localizedCompare($1.place) == .orderedAscending }
		let regions = named.map { prefix, name in TimeZoneRegion(name: name, choices: byPlace.filter { $0.zone.hasPrefix("\(prefix)/") }) }
		let inRegion = Set(regions.flatMap(\.choices))
		let others = TimeZoneRegion(name: otherName, choices: byPlace.filter { !inRegion.contains($0) })
		return (regions + [others]).filter { !$0.choices.isEmpty }
	}
}
