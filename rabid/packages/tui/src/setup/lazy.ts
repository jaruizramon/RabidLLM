import type { SetupHost } from "./scenes/types";

/** Load and run provider setup without completing onboarding or replaying the welcome intro. */
export async function runProviderSetupWizard(ctx: SetupHost): Promise<void> {
	// Keep the full setup wizard behind the existing cold-start boundary; a static
	// import here would load provider/OAuth/search/theme setup deps on every TUI startup.
	const [{ runSetupWizard }, { providersSetupScene }] = await Promise.all([
		import("./wizard"),
		import("./scenes/sign-in"),
	]);
	await runSetupWizard(ctx, [providersSetupScene], {
		markComplete: false,
		playWelcomeIntro: false,
	});
}
