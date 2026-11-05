import Foundation

/// How a file is drawn, by its media type and name; its raw value is the web's name for it.
enum FileLook: String {
	case image, pdf, sheet, other

	static func of(_ file: FilePart) -> FileLook {
		let type = mediaTypeEssence(file.contentType)
		if type.hasPrefix("image/") { return .image }
		let ext = extensionOf(file.name)
		if type == "application/pdf" || ext == "pdf" { return .pdf }
		if type == "text/csv" || sheetExtensions.contains(ext) { return .sheet }
		return .other
	}

	/// A media type without its parameters, as `mediaTypeEssence`: ` Text/CSV; charset=utf-8` is `text/csv`.
	static func mediaTypeEssence(_ mediaType: String) -> String {
		(mediaType.split(separator: ";", omittingEmptySubsequences: false).first.map(String.init) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
	}

	/// The part of `name` after its last dot, lowercased, or nothing when it has none.
	static func extensionOf(_ name: String) -> String {
		guard let dot = name.lastIndex(of: "."), dot > name.startIndex else { return "" }
		return name[name.index(after: dot)...].lowercased()
	}

	/// `512 B`, `40 KB`, `1.2 MB`.
	static func sizeLabel(_ bytes: Int) -> String {
		if bytes < 1024 { return "\(bytes) B" }
		let kilobytes = Int((Double(bytes) / 1024).rounded())
		if kilobytes < 1024 { return "\(kilobytes) KB" }
		return String(format: "%.1f MB", Double(bytes) / (1024 * 1024))
	}
}
