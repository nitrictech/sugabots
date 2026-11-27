import { expect, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { SearchField, useSearchFilter } from "./search-field.tsx";

const botNames = ["Growth Desk", "Issue Triager"];

const meta = preview.meta({
	title: "Controls/SearchField",
	component: SearchField,
	args: { label: "Search bots", look: "sidebar", value: "", onChange: () => {} },
});

/** FilterBots narrows the list as a member types and restores it when Escape clears the search. */
export const FilterBots = meta.story({
	render: function FilteredList(args) {
		const { query, setQuery, matches } = useSearchFilter(botNames, (name) => [name]);
		return (
			<div className="max-w-72 space-y-3">
				<SearchField {...args} value={query} onChange={setQuery} />
				<ul aria-label="Matching bots">
					{matches.map((name) => (
						<li key={name}>{name}</li>
					))}
				</ul>
			</div>
		);
	},
	play: async ({ canvas, userEvent }) => {
		const search = canvas.getByRole("searchbox", { name: "Search bots" });
		await userEvent.type(search, "growth");
		const list = within(canvas.getByRole("list", { name: "Matching bots" }));
		await waitFor(() => expect(list.getAllByRole("listitem")).toHaveLength(1));
		await expect(list.getByText("Growth Desk")).toBeVisible();
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(list.getByText("Issue Triager")).toBeVisible());
		await expect(search).toHaveFocus();
	},
});
