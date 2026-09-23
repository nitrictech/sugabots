import { cleanup, render, screen } from "@testing-library/react";
import { renderHashvatar } from "hashvatar";
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
	it("shows initials over the generated avatar", () => {
		render(<PersonAvatar name="Ryan Eyes" email="ryan@example.com" />);

		expect(screen.getByTitle("Ryan Eyes").textContent).toBe("RE");
	});

	it("gives two letters for a single name, so a stack stays even", () => {
		render(<PersonAvatar name="Jye" email="jye@example.com" />);

		expect(screen.getByTitle("Jye").textContent).toBe("JY");
	});

	it("uses the user's photo when available", () => {
		render(<PersonAvatar name="Ryan Eyes" email="ryan@example.com" image="/ryan.png" />);

		expect(screen.getByTitle("Ryan Eyes").querySelector("img")?.getAttribute("src")).toBe(
			"/ryan.png",
		);
		expect(screen.getByTitle("Ryan Eyes").textContent).toBe("");
	});

	it("uses normalized email for the generated avatar even when the name stays the same", () => {
		const { rerender } = render(<PersonAvatar name="Ryan Eyes" email="RYAN@Example.com " />);
		expect(vi.mocked(renderHashvatar).mock.lastCall?.[1]).toMatchObject({
			hash: "ryan@example.com",
			mode: "dither",
		});

		rerender(<PersonAvatar name="Ryan Eyes" email="ryan+new@example.com" />);
		expect(vi.mocked(renderHashvatar).mock.lastCall?.[1]).toMatchObject({
			hash: "ryan+new@example.com",
		});
	});
});
