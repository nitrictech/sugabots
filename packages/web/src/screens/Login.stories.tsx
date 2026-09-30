import { HttpResponse, http } from "msw";
import { expect, fn, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import { Login } from "./Login.tsx";

/*
 * Signing in, after the welcome (whose story is Views/Onboarding › Welcome):
 * the email form, making an account, the page an unverified address gets, and
 * the way into a password reset.
 */

const auth = `${import.meta.env.VITE_API_URL}/auth`;

const meta = preview.meta({
	title: "Views/Login",
	component: Login,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: { onSignedIn: fn(async () => {}) },
	render: (args) => (
		<div style={{ height: "100vh" }}>
			<Login {...args} />
		</div>
	),
});

/** Continue with email opens the form for an account that exists. */
export const LogIn = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Continue with email" }));
		await expect(await canvas.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
		await expect(canvas.getByLabelText("Email")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Back" })).toBeInTheDocument();
	},
});

/** Making an account asks for a name as well. */
export const CreateAccount = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Continue with email" }));
		await userEvent.click(await canvas.findByRole("button", { name: "Create an account" }));
		await expect(
			await canvas.findByRole("heading", { name: "Create an account" }),
		).toBeInTheDocument();
		await expect(canvas.getByLabelText("Name")).toBeInTheDocument();
	},
});

/** An installation that proves addresses: the account is made, and the link is in the inbox. */
export const CheckYourEmail = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.post(`${auth}/sign-up/email`, () =>
				HttpResponse.json({
					token: null,
					user: {
						id: "0199a3a0-0000-7000-8000-000000000009",
						name: "Ryan Eyes",
						email: "ryan@nitric.io",
					},
				}),
			),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Continue with email" }));
		await userEvent.click(await canvas.findByRole("button", { name: "Create an account" }));
		await userEvent.type(await canvas.findByLabelText("Name"), "Ryan Eyes");
		await userEvent.type(canvas.getByLabelText("Email"), "ryan@nitric.io");
		await userEvent.type(canvas.getByLabelText("Password"), "correct-horse");
		await userEvent.click(canvas.getByRole("button", { name: "Create account" }));
		await expect(
			await canvas.findByRole("heading", { name: "Check your email" }),
		).toBeInTheDocument();
		await expect(canvas.getByText(/ryan@nitric.io/)).toBeInTheDocument();
	},
});

/** From an invitation's link: straight to the form, saying why. */
export const FromAnInvitation = meta.story({
	args: { inviteId: "0199a3a0-0000-7000-8000-0000000000e1" },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("heading", { name: "Log in" })).toBeInTheDocument();
		await expect(canvas.getByText(/invited to a workspace/)).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Back" })).toBeNull();
	},
});

/** From a referral link: straight to making an account, which sends the link's code. */
export const FromAReferralLink = meta.story({
	args: { referralCode: "referral-code" },
	beforeEach({ msw }) {
		msw.use(
			http.post(`${auth}/sign-up/email`, async ({ request }) => {
				const body = (await request.json()) as { referralCode?: string };
				return body.referralCode === "referral-code"
					? HttpResponse.json({
							token: "session-token",
							user: {
								id: "0199a3a0-0000-7000-8000-000000000009",
								name: "Ryan Eyes",
								email: "ryan@nitric.io",
							},
						})
					: HttpResponse.json({ code: "SIGN_UP_CLOSED", message: "Closed" }, { status: 403 });
			}),
		);
	},
	play: async ({ args, canvas, userEvent }) => {
		await expect(canvas.getByRole("heading", { name: "Create an account" })).toBeInTheDocument();
		await expect(canvas.getByText(/invited to Sugabots/)).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Back" })).toBeNull();
		await userEvent.type(canvas.getByLabelText("Name"), "Ryan Eyes");
		await userEvent.type(canvas.getByLabelText("Email"), "ryan@nitric.io");
		await userEvent.type(canvas.getByLabelText("Password"), "correct-horse");
		await userEvent.click(canvas.getByRole("button", { name: "Create account" }));
		await waitFor(() => expect(args.onSignedIn).toHaveBeenCalled());
	},
});

/** Forgot password? asks for the address, carrying over what was typed. */
export const ForgotPassword = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Continue with email" }));
		await userEvent.type(await canvas.findByLabelText("Email"), "ryan@nitric.io");
		await userEvent.click(canvas.getByRole("button", { name: "Forgot password?" }));
		await expect(
			await canvas.findByRole("heading", { name: "Reset your password" }),
		).toBeInTheDocument();
		await expect(canvas.getByLabelText("Email")).toHaveValue("ryan@nitric.io");
	},
});

/** Back from a reset: straight to the form, saying the password changed. */
export const AfterPasswordReset = meta.story({
	args: { passwordChanged: true },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("heading", { name: "Log in" })).toBeInTheDocument();
		await expect(canvas.getByText(/password has been changed/)).toBeInTheDocument();
	},
});
