import { HttpResponse, http } from "msw";
import { expect, fn, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import { ResetPassword } from "./ResetPassword.tsx";

/*
 * Where a reset email's link lands: choosing the new password, and asking
 * again when the link has run out. Asking the first time starts from the log
 * in form, in Views/Login › Forgot Password.
 */

const auth = `${import.meta.env.VITE_API_URL}/auth`;

const meta = preview.meta({
	title: "Views/Reset Password",
	component: ResetPassword,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		token: "reset-token",
		onReset: fn(async () => {}),
		onBack: fn(),
	},
	render: (args) => (
		<div style={{ height: "100vh" }}>
			<ResetPassword {...args} />
		</div>
	),
});

/** A good link: the new password goes with its token. */
export const ChooseNewPassword = meta.story({
	beforeEach({ msw }) {
		msw.use(http.post(`${auth}/reset-password`, () => HttpResponse.json({ status: true })));
	},
	play: async ({ args, canvas, userEvent }) => {
		await expect(
			canvas.getByRole("heading", { name: "Choose a new password" }),
		).toBeInTheDocument();
		await userEvent.type(canvas.getByLabelText("Password"), "correct-horse-battery");
		await userEvent.click(canvas.getByRole("button", { name: "Change password" }));
		await waitFor(() => expect(args.onReset).toHaveBeenCalled());
	},
});

/** The API refused the link before it got here, so the page asks for another. */
export const ExpiredLink = meta.story({
	args: { token: undefined },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("heading", { name: "Reset your password" })).toBeInTheDocument();
		await expect(canvas.getByText(/expired or has already been used/)).toBeInTheDocument();
	},
});

/** The link ran out while the page was open: the same offer of another. */
export const ExpiredWhileOpen = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.post(`${auth}/reset-password`, () =>
				HttpResponse.json({ code: "INVALID_TOKEN", message: "Invalid token" }, { status: 400 }),
			),
		);
	},
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.type(canvas.getByLabelText("Password"), "correct-horse-battery");
		await userEvent.click(canvas.getByRole("button", { name: "Change password" }));
		await expect(
			await canvas.findByRole("heading", { name: "Reset your password" }),
		).toBeInTheDocument();
		await expect(args.onReset).not.toHaveBeenCalled();
	},
});

/** Asking again says the same thing whether or not the address has an account. */
export const LinkSent = meta.story({
	args: { token: undefined },
	beforeEach({ msw }) {
		msw.use(
			http.post(`${auth}/request-password-reset`, () =>
				HttpResponse.json({ status: true, message: "If this email exists, a link was sent" }),
			),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.type(canvas.getByLabelText("Email"), "ryan@nitric.io");
		await userEvent.click(canvas.getByRole("button", { name: "Send reset link" }));
		await expect(
			await canvas.findByRole("heading", { name: "Check your email" }),
		).toBeInTheDocument();
		await expect(canvas.getByText(/If ryan@nitric.io has an account/)).toBeInTheDocument();
	},
});
