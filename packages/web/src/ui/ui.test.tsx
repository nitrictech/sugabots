import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { TooltipProvider } from "@/ui/tooltip.tsx";

/**
 * The shared components, tested for the invariants that are the reason they are
 * shared — an icon button always has a name, a dialog is dismissable — rather
 * than for the utilities they happen to carry. Classes are the design's to
 * change; these are not.
 */

afterEach(cleanup);

describe("IconButton", () => {
	it("names itself for assistive technology from the label it requires", () => {
		render(
			<TooltipProvider>
				<IconButton label="New thread" onClick={vi.fn()}>
					<svg />
				</IconButton>
			</TooltipProvider>,
		);

		expect(screen.getByRole("button", { name: "New thread" })).toBeDefined();
	});

	it("can be a link, for a control that navigates rather than acts", () => {
		render(
			<TooltipProvider>
				<IconButton label="Workspace settings" render={<a href="/setup" />}>
					<svg />
				</IconButton>
			</TooltipProvider>,
		);

		const link = screen.getByRole("link", { name: "Workspace settings" });

		expect(link.getAttribute("href")).toBe("/setup");
	});
});

describe("PersonAvatar", () => {
	it("falls back to initials until there is a photo", () => {
		render(<PersonAvatar person={{ name: "Ryan Eyes", email: "ryan@example.com" }} />);

		expect(screen.getByTitle("Ryan Eyes").textContent).toBe("RE");
	});

	it("gives two letters for a single name, so a stack stays even", () => {
		render(<PersonAvatar person={{ name: "Jye", email: "jye@example.com" }} />);

		expect(screen.getByTitle("Jye").textContent).toBe("JY");
	});

	it("shows the Gravatar for the normalized email", async () => {
		render(<PersonAvatar person={{ name: "Ryan Eyes", email: " RYAN@Example.com" }} size={32} />);

		await vi.waitFor(() =>
			expect(screen.getByTitle("Ryan Eyes").querySelector("img")?.getAttribute("src")).toBe(
				"https://gravatar.com/avatar/5f58da4a1a2d0c8052a9827dec9389a285c3d60f07477e117fefb09da54fc894?s=64&d=404",
			),
		);
	});

	it("keeps the initials when there is no Gravatar", async () => {
		render(<PersonAvatar person={{ name: "Ryan Eyes", email: "ryan@example.com" }} />);
		const gravatar = await vi.waitFor(() => {
			const img = screen.getByTitle("Ryan Eyes").querySelector("img");
			if (!img) throw new Error("No Gravatar yet");
			return img;
		});

		fireEvent.error(gravatar);

		expect(screen.getByTitle("Ryan Eyes").querySelector("img")).toBeNull();
		expect(screen.getByTitle("Ryan Eyes").textContent).toBe("RE");
	});
});
