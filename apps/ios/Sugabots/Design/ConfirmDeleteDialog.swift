import SwiftUI

extension View {
	/// The web's `DeleteDialog`: a small card over a scrim that covers the
	/// whole screen, tabs and all, saying what goes, with Cancel and the red
	/// action side by side. It fades and zooms in, as the web's dialogs do,
	/// rather than sliding up.
	///
	/// The dialog runs `action` itself: its buttons wait while it runs, a
	/// failure is shown in the card, and the dialog closes only once it
	/// succeeds. `action` holds only the request and what follows it, such as
	/// leaving the page or reloading.
	func confirmDelete(
		isPresented: Binding<Bool>,
		title: String,
		description: String,
		confirmLabel: String = "Delete",
		action: @escaping () async throws -> Void
	) -> some View {
		fullScreenCover(isPresented: isPresented) {
			DeleteDialog(
				title: title,
				description: description,
				confirmLabel: confirmLabel,
				close: { isPresented.wrappedValue = false },
				action: action
			)
			.presentationBackground(.clear)
		}
		.transaction(value: isPresented.wrappedValue) { $0.disablesAnimations = true }
	}
}

private struct DeleteDialog: View {
	let title: String
	let description: String
	let confirmLabel: String
	let close: () -> Void
	let action: () async throws -> Void
	@State private var shown = false
	@State private var pending = false
	@State private var failure: String?

	var body: some View {
		let card = RoundedRectangle(cornerRadius: 20, style: .continuous)
		ZStack {
			Palette.scrim
				.ignoresSafeArea()
				.onTapGesture { if !pending { close() } }
			VStack(spacing: 0) {
				VStack(spacing: 8) {
					Text(title).font(Typeface.rubik(14, .semibold)).foregroundStyle(Palette.foreground)
					// The web's 1.55 leading over Rubik's own line height of about 1.19.
					Text(description).font(Typeface.rubik(13.5)).lineSpacing(5).foregroundStyle(Palette.mutedForeground)
					if let failure { FormAlert(text: failure).padding(.top, 8) }
				}
				.multilineTextAlignment(.center)
				.padding(.horizontal, 22)
				.padding(.top, 24)
				.padding(.bottom, 18)
				Rectangle().fill(Palette.borderStrong).frame(height: 1)
				HStack(spacing: 0) {
					Button(action: close) {
						Text("Cancel").font(Typeface.rubik(15, .medium)).foregroundStyle(Palette.softForeground)
							.frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
					}
					Rectangle().fill(Palette.borderStrong).frame(width: 1)
					Button(action: confirm) {
						Text(confirmLabel).font(Typeface.rubik(15, .semibold)).foregroundStyle(Palette.destructiveText)
							.frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
					}
				}
				.buttonStyle(.plain)
				.fixedSize(horizontal: false, vertical: true)
				.disabled(pending)
				.opacity(pending ? 0.5 : 1)
			}
			.frame(maxWidth: 360)
			.background(Palette.panel, in: card)
			// The web's `--dialog-shadow`: a deep shadow and a hairline ring, black in light and white in dark.
			.overlay(card.strokeBorder(Color.primary.opacity(0.06)))
			.shadow(color: .black.opacity(0.6), radius: 40, y: 30)
			.padding(.horizontal, 10)
			.scaleEffect(shown ? 1 : 0.95)
		}
		.opacity(shown ? 1 : 0)
		.onAppear { withAnimation(.easeOut(duration: 0.1)) { shown = true } }
		.accessibilityAddTraits(.isModal)
	}

	private func confirm() {
		pending = true
		failure = nil
		Task {
			do {
				try await action()
				close()
			} catch {
				failure = error.localizedDescription
			}
			pending = false
		}
	}
}
