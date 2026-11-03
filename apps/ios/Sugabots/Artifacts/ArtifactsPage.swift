import SwiftUI

/// The documents and pages a pod's bots have made, newest first, under when
/// each was last changed, as the web's `ArtifactListView` on a phone. Each
/// opens on a page of its own.
@MainActor
struct ArtifactsScreen: View {
	let pod: Pod
	@Environment(WorkspaceStore.self) private var store
	@State private var artifacts: [ArtifactSummary]?
	@State private var failed = false

	var body: some View {
		VStack(spacing: 0) {
			PodPageHeader(title: "Artifacts")
			if failed {
				EmptyState(title: "Could not load the artifacts", text: "The API did not answer. Reload, or check that it is running.")
			} else if let artifacts, artifacts.isEmpty {
				EmptyState(
					title: "No artifacts in \(pod.name) yet",
					icon: .fileText,
					text: "When a bot writes you a doc, report or page, it's saved here so the whole pod can find it later."
				)
				.padding(.bottom, 60)
			} else if let artifacts {
				ScrollView {
					LazyVStack(alignment: .leading, spacing: 20) {
						ForEach(Self.byWhen(artifacts, now: .now), id: \.label) { group in
							VStack(alignment: .leading, spacing: 2) {
								Text(group.label)
									.font(Typeface.rubik(12, .medium))
									.foregroundStyle(Palette.subtleForeground)
									.padding(.horizontal, 8)
									.padding(.bottom, 6)
									.accessibilityAddTraits(.isHeader)
								ForEach(group.artifacts) { artifact in
									ArtifactRow(pod: pod, artifact: artifact)
								}
							}
						}
					}
					.padding(.horizontal, 16)
					.padding(.top, 16)
					.padding(.bottom, 48)
				}
				.refreshable { await load() }
			} else {
				Spacer()
			}
		}
		.background(Palette.background.ignoresSafeArea())
		.task { await load() }
	}

	private func load() async {
		do {
			artifacts = try await store.artifacts(in: pod.id)
			failed = false
		} catch {
			failed = artifacts == nil
		}
	}

	struct Group {
		/// "Today", "Earlier this week", then the month, with its year when not this one.
		let label: String
		var artifacts: [ArtifactSummary]
	}

	/// The artifacts, newest first, under when each was last updated.
	static func byWhen(_ artifacts: [ArtifactSummary], now: Date) -> [Group] {
		var groups: [Group] = []
		let week: TimeInterval = 7 * 24 * 60 * 60
		for artifact in artifacts {
			let updated = artifact.updatedAt
			let sameYear = Calendar.current.isDate(updated, equalTo: now, toGranularity: .year)
			let label =
				Calendar.current.isDate(updated, inSameDayAs: now) ? "Today"
				: now.timeIntervalSince(updated) < week ? "Earlier this week"
				: sameYear ? updated.formatted(.dateTime.month(.wide))
				: updated.formatted(.dateTime.month(.wide).year())
			if groups.last?.label == label {
				groups[groups.count - 1].artifacts.append(artifact)
			} else {
				groups.append(Group(label: label, artifacts: [artifact]))
			}
		}
		return groups
	}
}

/// An artifact in the list: its kind, title, which version, who made it, and when it last changed.
private struct ArtifactRow: View {
	let pod: Pod
	let artifact: ArtifactSummary

	var body: some View {
		let kind = artifact.kind
		NavigationLink(value: Route.artifact(podId: pod.id, artifactId: artifact.id, version: nil)) {
			HStack(spacing: 12) {
				Icon(kind.icon, size: 16, strokeWidth: 1.75)
					.foregroundStyle(Palette.mutedForeground)
					.frame(width: 32, height: 32)
					.background(Palette.chip, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
				VStack(alignment: .leading, spacing: 1) {
					Text(artifact.title).font(Typeface.rubik(13, .medium)).foregroundStyle(Palette.foreground).lineLimit(1)
					Text([kind.label, "v\(artifact.version)", artifact.createdBy?.name ?? "A removed bot"].joined(separator: ", "))
						.font(Typeface.rubik(12))
						.foregroundStyle(Palette.subtleForeground)
						.lineLimit(1)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				Text(Times.list(artifact.updatedAt)).font(Typeface.rubik(12)).foregroundStyle(Palette.subtleForeground)
			}
			.padding(8)
			.contentShape(Rectangle())
		}
		.buttonStyle(PressableRowStyle(pressed: Palette.messageHover, cornerRadius: 10))
	}
}

/// An artifact opened on its own page, as the web's `ArtifactStage` on a
/// phone: Back, its title and who wrote this version when, the version
/// shown with the others to switch to, and ⋯ with Download, Copy link and,
/// for those who may, Delete.
@MainActor
struct ArtifactScreen: View {
	let podId: String
	let artifactId: String
	/// An earlier version to show; the current one when nil.
	@State var version: Int?
	@Environment(WorkspaceStore.self) private var store
	@Environment(Toaster.self) private var toaster
	@Environment(\.dismiss) private var dismiss
	@State private var artifact: Artifact?
	@State private var versions: [ArtifactVersionSummary] = []
	@State private var failed = false
	@State private var confirmingDelete = false
	@State private var download: SavedFile?

	var body: some View {
		let pod = store.pod(id: podId)
		VStack(spacing: 0) {
			HStack(spacing: 8) {
				PhoneBackButton()
				VStack(alignment: .leading, spacing: 1) {
					Text(artifact?.title ?? "")
						.font(Typeface.rubik(17, .semibold))
						.foregroundStyle(Palette.foreground)
						.lineLimit(1)
					if let artifact {
						Text("\(artifact.shownVersion.author?.name ?? "A removed bot") \(Self.writtenWhen(artifact.shownVersion.createdAt))")
							.font(Typeface.rubik(12))
							.foregroundStyle(Palette.subtleForeground)
							.lineLimit(1)
					}
				}
				.padding(.leading, 4)
				.frame(maxWidth: .infinity, alignment: .leading)
				if let artifact {
					versionPicker(artifact)
					moreMenu(artifact, pod: pod)
				}
			}
			.pageHeaderInsets()
			Group {
				if let artifact {
					content(artifact)
				} else if failed {
					EmptyState(title: "No such artifact here", text: "It may have been removed, or the API did not answer.")
				} else {
					Spacer()
				}
			}
			.padding(.horizontal, 12)
			.padding(.top, 16)
			.padding(.bottom, 12)
		}
		.background(Palette.background.ignoresSafeArea())
		.task(id: version) { await load() }
		.confirmDelete(
			isPresented: $confirmingDelete,
			title: "Delete \(artifact?.title ?? "")?",
			description: "Every version goes with it, for everyone in the pod. Replies that showed it keep only its name. This can't be undone."
		) {
			try await store.deleteArtifact(artifactId, in: podId)
			dismiss()
		}
		.sheet(item: $download) { file in
			ShareSheet(items: [file.url])
		}
	}

	@ViewBuilder private func content(_ artifact: Artifact) -> some View {
		let border = RoundedRectangle(cornerRadius: 12, style: .continuous)
		if artifact.kind == .html {
			ArtifactFrame(html: artifact.content, title: artifact.title, podId: artifact.podId, artifactId: artifact.id, version: artifact.shownVersion.number)
				.clipShape(border)
				.overlay(border.strokeBorder(Palette.border))
		} else {
			ScrollView {
				MessageMarkdown(text: artifact.content)
					.frame(maxWidth: 760, alignment: .leading)
					.padding(.horizontal, 16)
					.padding(.vertical, 24)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
			.background(Palette.list, in: border)
			.overlay(border.strokeBorder(Palette.border))
		}
	}

	/// Which version is shown, round on glass, and the others to switch to.
	private func versionPicker(_ artifact: Artifact) -> some View {
		let shown = artifact.shownVersion.number
		let isCurrent = shown == artifact.version
		return Menu {
			ForEach(versions) { candidate in
				Button {
					version = candidate.number == artifact.version ? nil : candidate.number
				} label: {
					let byline = candidate.author.map { "by \($0.name)" } ?? "by a removed bot"
					let label = "Version \(candidate.number) \(byline) · \(Times.list(candidate.createdAt))"
					if candidate.number == shown { Label(label, systemImage: "checkmark") } else { Text(label) }
				}
			}
		} label: {
			HStack(spacing: 6) {
				Text("v\(shown)\(isCurrent ? "" : " of \(artifact.version)")")
					.font(Typeface.rubik(12.5))
					.foregroundStyle(isCurrent ? Palette.softForeground : Palette.foreground)
				Icon(.chevronDown, size: 12).foregroundStyle(Palette.subtleForeground)
			}
			.padding(.leading, 14)
			.padding(.trailing, 12)
			.frame(height: 44)
			.glass(in: Capsule())
		}
		.accessibilityLabel("Version \(shown) of \(artifact.version)")
	}

	private func moreMenu(_ artifact: Artifact, pod: Pod?) -> some View {
		Menu {
			Button { saveForDownload(artifact) } label: { Label("Download", systemImage: "arrow.down.to.line") }
			if let pod {
				Button {
					UIPasteboard.general.url = store.webLink(toArtifact: artifact.id, in: pod)
					toaster.show("Copied")
				} label: { Label("Copy link", systemImage: "link") }
				if pod.permissions.deleteArtifacts {
					Button(role: .destructive) { confirmingDelete = true } label: { Label("Delete", systemImage: "trash") }
				}
			}
		} label: {
			GlassRoundIcon(icon: .ellipsis)
		}
		.accessibilityLabel("More")
	}

	private func load() async {
		do {
			async let shown = store.artifact(artifactId, in: podId, version: version)
			async let all = store.artifactVersions(artifactId, in: podId)
			artifact = try await shown
			versions = (try? await all) ?? versions
		} catch {
			failed = artifact == nil
		}
	}

	/// Saves the artifact as shown as a file named after its title, for the share sheet.
	private func saveForDownload(_ artifact: Artifact) {
		let kind = artifact.kind
		var name = artifact.title.replacingOccurrences(of: "[\\\\/:*?\"<>|]+", with: "-", options: .regularExpression)
			.trimmingCharacters(in: .whitespaces)
		if !name.lowercased().hasSuffix(".\(kind.fileExtension)") { name += ".\(kind.fileExtension)" }
		let content = artifact.kind == .html ? PageTheme(dark: false).written(into: artifact.content) : artifact.content
		let file = FileManager.default.temporaryDirectory.appending(path: name)
		do {
			try content.write(to: file, atomically: true, encoding: .utf8)
			download = SavedFile(url: file)
		} catch {
			toaster.show(error.localizedDescription)
		}
	}

	/// When a version was written, to follow its author: "at 2:46", "yesterday", "on Mon", "on 14 Sep".
	static func writtenWhen(_ date: Date) -> String {
		let shown = Times.listInSentence(date)
		switch Times.daysAgo(date) {
		case ...0: return "at \(shown)"
		case 1: return shown
		default: return "on \(shown)"
		}
	}
}
