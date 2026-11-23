import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SearchField, useSearchFilter } from "@/ui/search-field.tsx";
import { SettingsNameRow } from "@/ui/settings-page.tsx";
import { TooltipProvider } from "@/ui/tooltip.tsx";

afterEach(cleanup);

describe("IconButton", () => {
	it("names itself for assistive technology from the label it requires", () => {
		render(
			<TooltipProvider>
				<IconButton label="New chat" onClick={vi.fn()}>
					<svg />
				</IconButton>
			</TooltipProvider>,
		);

		expect(screen.getByRole("button", { name: "New chat" })).toBeDefined();
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
		render(<PersonAvatar person={{ name: "Rowan Ellis", email: "rowan@example.com" }} />);

		expect(screen.getByTitle("Rowan Ellis").textContent).toBe("RE");
	});

	it("gives two letters for a single name, so a stack stays even", () => {
		render(<PersonAvatar person={{ name: "Juno", email: "juno@example.com" }} />);

		expect(screen.getByTitle("Juno").textContent).toBe("JU");
	});

	it("shows the Gravatar for the normalized email", async () => {
		render(<PersonAvatar person={{ name: "Rowan Ellis", email: " ROWAN@Example.com" }} />);

		await vi.waitFor(() =>
			expect(screen.getByTitle("Rowan Ellis").querySelector("img")?.getAttribute("src")).toBe(
				"https://gravatar.com/avatar/d9d745372fba31973b3ba22d208479cdbb4d80fe62434ab86e1e93fb87fefde0?s=128&d=404",
			),
		);
	});

	it("asks for the same Gravatar image for avatars up to 64 pixels", async () => {
		const rowan = { name: "Rowan Ellis", email: "rowan@example.com" };
		render(
			<>
				<PersonAvatar person={rowan} size={20} />
				<PersonAvatar person={rowan} size={64} />
			</>,
		);

		await vi.waitFor(() => {
			const [small, large] = screen
				.getAllByTitle("Rowan Ellis")
				.map((avatar) => avatar.querySelector("img")?.getAttribute("src"));
			expect(small).toEqual(expect.stringContaining("gravatar.com/avatar/"));
			expect(small).toBe(large);
		});
	});

	it("keeps the initials when there is no Gravatar", async () => {
		render(<PersonAvatar person={{ name: "Rowan Ellis", email: "rowan@example.com" }} />);
		const gravatar = await vi.waitFor(() => {
			const img = screen.getByTitle("Rowan Ellis").querySelector("img");
			if (!img) throw new Error("No Gravatar yet");
			return img;
		});

		fireEvent.error(gravatar);

		expect(screen.getByTitle("Rowan Ellis").querySelector("img")).toBeNull();
		expect(screen.getByTitle("Rowan Ellis").textContent).toBe("RE");
	});
});

describe("SearchField", () => {
	function Search() {
		const [query, setQuery] = useState("");
		return <SearchField label="Search bots" value={query} onChange={setQuery} />;
	}

	it("clears what was typed on Escape", () => {
		render(<Search />);
		const field = screen.getByRole("searchbox", { name: "Search bots" });

		fireEvent.change(field, { target: { value: "trip" } });
		fireEvent.keyDown(field, { key: "Escape" });

		expect((field as HTMLInputElement).value).toBe("");
	});
});

describe("useSearchFilter", () => {
	const bots = [
		{ name: "Trip Planner", handle: "trips" },
		{ name: "Inbox Sorter", handle: "rowan-mail" },
	];

	function FilteredBots() {
		const { query, setQuery, matches } = useSearchFilter(bots, (bot) => [bot.name, bot.handle]);
		return (
			<>
				<SearchField label="Search bots" value={query} onChange={setQuery} />
				<ul>
					{matches.map((bot) => (
						<li key={bot.name}>{bot.name}</li>
					))}
				</ul>
			</>
		);
	}

	it("matches what is typed in any field, ignoring case and surrounding spaces", async () => {
		render(<FilteredBots />);

		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "  ROWAN " } });

		await waitFor(() =>
			expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
				"Inbox Sorter",
			]),
		);
	});
});

describe("SettingsNameRow", () => {
	function edit(onCommit: (name: string) => unknown, typed: string) {
		render(<SettingsNameRow name="Lisbon trip" onCommit={onCommit} />);
		const field = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
		fireEvent.change(field, { target: { value: typed } });
		return field;
	}

	it("saves the name trimmed when the field is left", () => {
		const onCommit = vi.fn();
		const field = edit(onCommit, "  Porto trip  ");

		fireEvent.blur(field);

		expect(onCommit).toHaveBeenCalledWith("Porto trip");
		expect(field.value).toBe("Porto trip");
	});

	it("puts the saved name back on Escape, without saving", () => {
		const onCommit = vi.fn();
		const field = edit(onCommit, "Porto trip");

		fireEvent.keyDown(field, { key: "Escape" });
		fireEvent.blur(field);

		expect(field.value).toBe("Lisbon trip");
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("puts the saved name back when saving fails", async () => {
		const field = edit(() => Promise.reject(new Error("Offline")), "Porto trip");

		fireEvent.blur(field);

		await waitFor(() => expect(field.value).toBe("Lisbon trip"));
	});
});
