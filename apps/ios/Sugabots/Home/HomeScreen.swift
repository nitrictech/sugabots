import SwiftUI

/// Home, as the web's `MobileHome`: every pod down a rail at the left, and
/// beside it the one chosen, with its artifacts, then its channels and its
/// bots, each bot with its routines and threads under it.
struct HomeScreen: View {
	@Environment(WorkspaceStore.self) private var store

	var body: some View {
		let pods = store.podsInRailOrder
		let pod = pods.first { $0.id == store.preferences.homePodId } ?? pods.first
		HStack(spacing: 0) {
			PodRail(pods: pods, current: pod) { store.preferences.homePodId = $0.id }
			Group {
				if let pod {
					PodPanel(pod: pod).id(pod.id)
				} else {
					EmptyState(title: store.loadError == nil ? "Loading pods…" : "Could not load the pods", text: store.loadError)
				}
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity)
			.background {
				// Down to the screen's foot, under the tabs; the web's inset shadow is a line along the top and the left only.
				UnevenRoundedRectangle(topLeadingRadius: 20, style: .continuous)
					.fill(Palette.list)
					.overlay(
						UnevenRoundedRectangle(topLeadingRadius: 20, style: .continuous)
							.stroke(Palette.border, lineWidth: 1)
							.padding(.trailing, -1)
							.padding(.bottom, -1)
					)
					.ignoresSafeArea(edges: .bottom)
			}
		}
		.pageTopPadding()
		.background(Palette.background.ignoresSafeArea())
	}
}

/// Every pod as a tile, shared first, then Personal. A bar at the rail's
/// edge marks the one open, and a short one a pod with something new. The +
/// at the foot makes a pod, for somebody who may.
private struct PodRail: View {
	let pods: [Pod]
	let current: Pod?
	let choose: (Pod) -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var creating = false

	var body: some View {
		ScrollView(showsIndicators: false) {
			VStack(spacing: 10) {
				ForEach(pods) { pod in
					let isCurrent = pod.id == current?.id
					let news = store.hasNews(in: pod)
					Button { choose(pod) } label: {
						PodTile(pod: pod)
					}
					.buttonStyle(.plain)
					// Held, its notifications, as the web's sidebar gives a pod on a right click.
					.contextMenu { NotificationMenu(place: .pod(id: pod.id)) }
					.frame(maxWidth: .infinity)
					.overlay(alignment: .leading) {
						if isCurrent || news {
							UnevenRoundedRectangle(bottomTrailingRadius: 4, topTrailingRadius: 4)
								.fill(Palette.foreground)
								.frame(width: 4, height: isCurrent ? 36 : 8)
						}
					}
					.animation(.easeOut(duration: 0.15), value: isCurrent)
					.accessibilityLabel(news ? "\(pod.name), something new" : pod.name)
					.accessibilityAddTraits(isCurrent ? .isSelected : [])
				}
				if store.permissions?.createPods ?? false {
					Rectangle().fill(Palette.border).frame(width: 28, height: 1).padding(.vertical, 2)
					Button { creating = true } label: {
						Icon(.plus, size: 20, strokeWidth: 2)
							.foregroundStyle(Palette.subtleForeground)
							.frame(width: 46, height: 46)
							.background(Palette.chip, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
					}
					.buttonStyle(.plain)
					.accessibilityLabel("New pod")
				}
			}
			.padding(.top, 6)
			.padding(.bottom, 16)
		}
		.frame(width: 68)
		.refreshable { await store.refreshAll() }
		.sheet(isPresented: $creating) {
			NewPodSheet { pod in
				creating = false
				choose(pod)
			}
		}
	}
}

/// The pod chosen: its name, which opens its settings, then Artifacts and its conversations.
@MainActor
private struct PodPanel: View {
	let pod: Pod
	@Environment(WorkspaceStore.self) private var store

	var body: some View {
		VStack(spacing: 0) {
			// Pushed on Home, so Back comes straight back here, rather than opened under You.
			NavigationLink(value: Route.podSettings(pod)) {
				HStack(spacing: 6) {
					Text(pod.name)
						.font(Typeface.rubik(22, .semibold))
						.tracking(-0.44)
						.lineLimit(1)
					Icon(.chevronRight, size: 16, strokeWidth: 2)
						.foregroundStyle(Palette.subtleForeground)
				}
				.foregroundStyle(Palette.foreground)
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.buttonStyle(.plain)
			.accessibilityLabel("\(pod.name) settings")
			.padding(.leading, 18)
			.padding(.trailing, 12)
			.padding(.top, 18)
			.padding(.bottom, 12)

			ScrollView {
				VStack(alignment: .leading, spacing: 10) {
					NavigationLink(value: Route.artifacts(pod)) {
						HStack(spacing: 12) {
							Icon(.library, size: 20, strokeWidth: 1.75)
							Text("Artifacts").font(Typeface.rubik(16))
							Spacer(minLength: 0)
						}
						.foregroundStyle(Palette.mutedForeground)
						.padding(.horizontal, 12)
						.frame(height: 44)
						.contentShape(Rectangle())
					}
					.buttonStyle(.sidebarRow)
					Rectangle().fill(Palette.border).frame(height: 1).padding(.horizontal, 12)
					ConversationList(pod: pod)
				}
				.padding(.leading, 6)
				.padding(.trailing, 8)
				.padding(.bottom, 16)
				}
			.refreshable { await store.refreshAll() }
		}
		.task { await store.refreshChatList(pod) }
	}
}
