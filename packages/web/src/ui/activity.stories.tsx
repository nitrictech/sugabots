import { SearchIcon } from "lucide-react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import {
	Activity,
	ActivityCollapsible,
	ActivityCollapsibleContent,
	ActivityCollapsibleTrigger,
	ActivityDescription,
	ActivityIcon,
	ActivityLine,
	ActivityTitle,
} from "./activity.tsx";

const meta = preview.meta({
	title: "Controls/Activity",
	component: Activity,
	tags: ["ai-generated"],
});

/**
 * Lines shows a turn's steps: one still running, one that failed, and one that
 * opens onto what it found.
 */
export const Lines = meta.story({
	render: () => (
		<div className="w-96 p-4">
			<Activity>
				<ActivityLine status="running">
					<ActivityTitle>Searching the web</ActivityTitle>
				</ActivityLine>
				<ActivityLine status="error">
					<ActivityTitle>Read linear.app/changelog</ActivityTitle>
					<ActivityDescription>Failed</ActivityDescription>
				</ActivityLine>
				<ActivityCollapsible>
					<ActivityCollapsibleTrigger>
						<ActivityLine>
							<ActivityIcon>
								<SearchIcon />
							</ActivityIcon>
							<ActivityTitle>Searched for release notes</ActivityTitle>
							<ActivityDescription>3 results</ActivityDescription>
						</ActivityLine>
					</ActivityCollapsibleTrigger>
					<ActivityCollapsibleContent>
						Linear's changelog, its blog, and a forum thread about the release.
					</ActivityCollapsibleContent>
				</ActivityCollapsible>
			</Activity>
		</div>
	),
	play: async ({ canvas, userEvent }) => {
		const trigger = canvas.getByRole("button", { name: /Searched for release notes/ });
		await userEvent.click(trigger);
		await expect(trigger).toHaveAttribute("aria-expanded", "true");
		await expect(canvas.getByText(/a forum thread about the release/)).toBeVisible();
	},
});
