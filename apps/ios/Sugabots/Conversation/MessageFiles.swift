import SwiftUI
import UIKit

/// The files on a message, as the web's `MessageFiles`: pictures as tiles,
/// which open over the screen, and other files as chips with their kind,
/// size and Download.
@MainActor
struct MessageFiles: View {
	let files: [FilePart]
	let conversationId: String
	/// Whether the server has them yet; a message being sent has none to show.
	let sent: Bool

	var body: some View {
		let images = files.filter { FileLook.of($0) == .image }
		let others = files.filter { FileLook.of($0) != .image }
		VStack(alignment: .leading, spacing: 6) {
			if images.count == 1, let only = images.first {
				ImageTile(file: only, conversationId: conversationId, sent: sent, fit: .fit)
					.aspectRatio(4 / 3, contentMode: .fit)
					.frame(maxWidth: 360)
			} else if !images.isEmpty {
				let columns = images.count == 2 ? 2 : 3
				LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: columns), spacing: 4) {
					ForEach(images) { file in
						ImageTile(file: file, conversationId: conversationId, sent: sent, fit: .fill)
							.aspectRatio(4 / 3, contentMode: .fit)
					}
				}
				.frame(maxWidth: images.count == 2 ? 320 : 482)
			}
			ForEach(others) { file in
				FileChip(file: file, conversationId: conversationId, sent: sent)
			}
		}
		.padding(.top, 6)
	}
}

extension FileLook {
	var icon: Lucide {
		switch self {
		case .pdf: .fileText
		case .sheet: .fileSpreadsheet
		default: .fileIcon
		}
	}
}

/// A file's bytes, fetched with the person's token, kept on disk under its name so it can be shared or opened.
@MainActor
enum ChatFiles {
	/// The files fetched lately, by id, oldest first, at most `cacheLimit` of them.
	private static var cache: [(fileId: String, url: URL)] = []
	/// How many fetched files stay on disk; fetching another deletes the oldest.
	private static let cacheLimit = 50

	/// `file` on disk, in a folder of its own under the temporary directory, fetched unless it was lately.
	static func local(_ file: FilePart, in conversationId: String, client: APIClient) async throws -> URL {
		if let cached = cache.first(where: { $0.fileId == file.id })?.url, FileManager.default.fileExists(atPath: cached.path()) {
			return cached
		}
		let data = try await client.chats.file(conversationId: conversationId, fileId: file.id)
		let folder = FileManager.default.temporaryDirectory.appending(path: "chat-files").appending(path: pathComponent(file.id, else: "file"))
		try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
		let url = folder.appending(path: pathComponent(file.name, else: file.id))
		try data.write(to: url)
		remember(url, for: file.id)
		return url
	}

	/// `name` as one name in a folder, so it can't reach outside it: its last
	/// part after any `/`, or `fallback` when that is empty, `.` or `..`.
	private static func pathComponent(_ name: String, else fallback: String) -> String {
		let last = name.split(separator: "/").last.map(String.init) ?? ""
		return last.isEmpty || last == "." || last == ".." ? fallback : last
	}

	private static func remember(_ url: URL, for fileId: String) {
		cache.removeAll { $0.fileId == fileId }
		cache.append((fileId, url))
		while cache.count > cacheLimit {
			let oldest = cache.removeFirst()
			try? FileManager.default.removeItem(at: oldest.url.deletingLastPathComponent())
		}
	}
}

/// A button that fetches `file`, then offers it to save or share, as a phone
/// downloads; a failure shows as a toast.
@MainActor
struct ShareFileButton<Label: View>: View {
	let file: FilePart
	let conversationId: String
	@ViewBuilder let label: Label
	@Environment(WorkspaceStore.self) private var store
	@Environment(Toaster.self) private var toaster
	@State private var saved: SavedFile?

	var body: some View {
		Button(action: fetch) { label }
			.sheet(item: $saved) { saved in ShareSheet(items: [saved.url]) }
	}

	private func fetch() {
		Task {
			do {
				saved = SavedFile(url: try await ChatFiles.local(file, in: conversationId, client: store.client))
			} catch {
				toaster.show(error.localizedDescription)
			}
		}
	}
}

@MainActor
private struct ImageTile: View {
	let file: FilePart
	let conversationId: String
	let sent: Bool
	let fit: ContentMode
	@Environment(WorkspaceStore.self) private var store
	@State private var image: UIImage?
	@State private var undrawable = false
	@State private var viewing = false

	var body: some View {
		Button { viewing = true } label: {
			ZStack {
				Palette.tile
				if let image {
					Image(uiImage: image).resizable().aspectRatio(contentMode: fit)
				} else if undrawable || !sent {
					VStack(spacing: 4) {
						Icon(.fileIcon, size: 18)
						Text(file.name).font(Typeface.rubik(11)).lineLimit(1).truncationMode(.middle)
					}
					.foregroundStyle(Palette.mutedForeground)
					.padding(.horizontal, 8)
				}
			}
			.clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
			.overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.border))
		}
		.buttonStyle(.plain)
		.disabled(!sent)
		.accessibilityLabel("Open \(file.name)")
		.task(id: sent) {
			guard sent, image == nil else { return }
			guard let url = try? await ChatFiles.local(file, in: conversationId, client: store.client) else {
				undrawable = true
				return
			}
			image = UIImage(contentsOfFile: url.path())
			undrawable = image == nil
		}
		.fullScreenCover(isPresented: $viewing) {
			ImageViewer(file: file, image: image, conversationId: conversationId)
		}
	}
}

/// A picture over the whole screen on black: Close at the left, its name, and Download at the right.
private struct ImageViewer: View {
	let file: FilePart
	let image: UIImage?
	let conversationId: String
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		VStack(spacing: 12) {
			HStack(spacing: 12) {
				GlassRoundButton(icon: .x, label: "Close", iconSize: 20) { dismiss() }
				Text(file.name)
					.font(Typeface.rubik(15))
					.foregroundStyle(.white)
					.lineLimit(1)
					.truncationMode(.middle)
					.frame(maxWidth: .infinity)
				DownloadButton(file: file, conversationId: conversationId, round: true)
			}
			.padding(.horizontal, 16)
			.pageTopPadding()
			Group {
				if let image {
					Image(uiImage: image).resizable().scaledToFit()
				} else {
					Text("This picture can't be shown here. Download it to open it.")
						.font(Typeface.rubik(14))
						.foregroundStyle(Palette.mutedForeground)
						.multilineTextAlignment(.center)
						.padding(.horizontal, 16)
				}
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity)
		}
		.padding(.bottom, 16)
		.background(Color.black.ignoresSafeArea())
		.environment(\.colorScheme, .dark)
	}
}

/// A file that isn't a picture: its kind's mark, its name, its kind and size, and Download.
private struct FileChip: View {
	let file: FilePart
	let conversationId: String
	let sent: Bool

	var body: some View {
		let ext = FileLook.extensionOf(file.name).uppercased()
		HStack(spacing: 10) {
			Icon(FileLook.of(file).icon, size: 16)
				.foregroundStyle(Palette.softForeground)
				.frame(width: 32, height: 32)
				.background(Palette.tile, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
			VStack(alignment: .leading, spacing: 1) {
				Text(file.name).font(Typeface.rubik(14, .medium)).foregroundStyle(Palette.foreground).lineLimit(1).truncationMode(.middle)
				Text((ext.isEmpty ? "" : "\(ext) · ") + FileLook.sizeLabel(file.size))
					.font(Typeface.rubik(12))
					.foregroundStyle(Palette.subtleForeground)
			}
			.frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
			if sent { DownloadButton(file: file, conversationId: conversationId, round: false) }
		}
		.padding(.vertical, 8)
		.padding(.leading, 10)
		.padding(.trailing, 8)
		.background(Palette.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
		.overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.border))
	}
}

/// Download: fetches the file, then offers it to save or share, as a phone downloads.
private struct DownloadButton: View {
	let file: FilePart
	let conversationId: String
	let round: Bool

	var body: some View {
		ShareFileButton(file: file, conversationId: conversationId) {
			Icon(.download, size: round ? 20 : 16, strokeWidth: 2)
				.foregroundStyle(round ? Palette.foreground : Palette.mutedForeground)
				.frame(width: round ? 44 : 30, height: round ? 44 : 30)
				.contentShape(Circle())
		}
		.buttonStyle(.plain)
		.modifier(GlassIf(on: round))
		.accessibilityLabel("Download \(file.name)")
	}
}

private struct GlassIf: ViewModifier {
	let on: Bool

	func body(content: Content) -> some View {
		if on { content.glass(in: Circle()) } else { content }
	}
}
