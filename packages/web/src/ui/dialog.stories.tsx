import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { Button } from "./button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "./dialog.tsx";

const providers = [
	{ name: "Anthropic", detail: "6 models enabled" },
	{ name: "OpenAI", detail: "3 models enabled" },
	{ name: "Ollama", detail: "Connects to localhost:11434" },
];

const meta = preview.meta({
	title: "Patterns/Dialog",
	component: DialogContent,
	parameters: { layout: "fullscreen" },
	args: {},
	render: (args) => (
		<div className="flex min-h-dvh flex-col gap-4 bg-background p-8">
			<h1 className="font-display text-2xl text-heading">Model providers</h1>
			<p className="max-w-prose text-muted-foreground">
				Every provider you connect offers its models to the agents in this workspace.
			</p>
			{providers.map((provider) => (
				<div key={provider.name} className="surface-card flex justify-between gap-4 p-4">
					<span className="font-medium">{provider.name}</span>
					<span className="text-muted-foreground">{provider.detail}</span>
				</div>
			))}
			<Dialog>
				<DialogTrigger render={<Button variant="secondary" className="self-start" />}>
					Disconnect Anthropic
				</DialogTrigger>
				<DialogContent {...args}>
					<DialogHeader>
						<DialogTitle>Disconnect Anthropic?</DialogTitle>
						<DialogDescription>
							Agents using its models stop answering until you connect another provider.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>Keep</DialogClose>
						<Button variant="destructive">Disconnect</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	),
});

/**
 * Scrim covers the page behind the dialog: the backdrop both dims and blurs it, which is
 * what separates a modal from a panel. Worth reviewing in dark mode too, where the blur has
 * far less contrast to work with.
 */
export const Scrim = meta.story({
	play: async ({ canvas, canvasElement, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Disconnect Anthropic" }));
		const { body } = canvasElement.ownerDocument;
		await within(body).findByRole("dialog");

		await expect(body.querySelector('[data-slot="dialog-overlay"]')).not.toBeNull();
	},
});
