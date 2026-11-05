# Publishing to npm

The package name is `@tkellogg/dsh-program-agents`. Publishing requires an npm account with access to the `@tkellogg` scope. The package is configured for public access.

For interactive publishing, enable **two-factor authentication (2FA)** on your npm account before the first release. On npmjs.com, open **Account → Two-Factor Authentication → Enable 2FA**; a passkey or Touch ID can serve as your security key. npm requires account 2FA or a granular access token with bypass 2FA enabled. A successful CLI login alone does not satisfy this publishing requirement. See npm's [2FA setup instructions](https://docs.npmjs.com/configuring-two-factor-authentication/).

## Build and inspect the release

From the repository root, with Node.js 22.18+ and pnpm 10 installed:

```sh
pnpm install --frozen-lockfile
pnpm release:pack
```

The `prepack` hook runs `pnpm check`: the build, reference typecheck, and test suite. A failure stops packaging. The archive is saved in `.state/npm-release/`, with its name and version taken from `package.json`. Consumers receive compiled JavaScript and declarations; installation from npm doesn't run the build.

Inspect the resulting archive and preview publishing it:

```sh
pnpm release:inspect
pnpm release:publish:dry-run
```

It should contain `dist/host/index.js`, `dist/client.js`, the SDK and runtime exports, `cordis.patch.yml`, and `skills/program-agents/SKILL.md` with its supporting files. Local installation history, test records, logs, and credentials are excluded from the package.

The publishing dry run skips Git checks so it can preview uncommitted work. The actual publishing command keeps pnpm's normal Git checks enabled.

Test the archive in a disposable DSH profile before publishing. Installing it with `dsh plugin --profile web add /absolute/path/to/the/archive.tgz` enables the plugin through its bundle patch. Install the skill as described in the README.

## Publish the verified archive

Sign in and publish the same archive you inspected:

```sh
pnpm release:login
pnpm release:publish
```

Follow any authentication prompts from npm. Publishing uses the existing archive without rebuilding it. After the first release succeeds, remove the pending-release wording from the README and make npm installation the default. For future releases, update the package version and run `pnpm release:pack` again; the scripts select the matching archive automatically.

If publishing fails with **E403: Two-factor authentication or granular access token with bypass 2fa enabled is required**, check your account's 2FA settings. After enabling 2FA, run `pnpm release:login` again and retry `pnpm release:publish` in an interactive terminal. The authentication error does not require rebuilding the archive. If your configured method uses an authenticator code, you can pass it directly with `pnpm release:publish --otp=YOUR_CURRENT_CODE`; the release script forwards that option to pnpm.

See pnpm's [packing](https://pnpm.io/10.x/cli/pack) and [publishing](https://pnpm.io/10.x/cli/publish) documentation.
