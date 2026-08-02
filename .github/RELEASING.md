# Cutting a release

Releases are built by `.github/workflows/release.yml`, which fires on any pushed `v*` tag.

```sh
# 1. main is green (CI runs on every push and PR) and package.json "version" matches
git tag v0.1.0
git push origin v0.1.0
```

A short `draft` job creates the **draft** release for the tag (or reuses one that is already
there). Two build jobs then run in parallel — one on `macos-latest`, one on `windows-latest` —
each building its own installers, computing SHA-256 checksums, and uploading into that one
draft. Draft creation is deliberately a separate job: GitHub does not bind a draft to its tag
until it is published, so two jobs both calling `gh release create --draft` would both succeed
and leave two half-filled drafts.

When both jobs are green, open the draft on GitHub, write the changelog, check the asset list
below is complete, and hit **Publish release**. Nothing is public until you do.

## Assets

Builds are unsigned (`build.mac.identity` is `null`, and the workflow also sets
`CSC_IDENTITY_AUTO_DISCOVERY=false` so a stray keychain identity can never be picked up).
electron-builder is invoked with `--publish never`, so the release is assembled by the `gh`
CLI, not by electron-builder.

For version `0.1.0` the draft should carry:

| File | What it is |
| --- | --- |
| `SubSplit-0.1.0-arm64.dmg` | macOS disk image, Apple silicon |
| `SubSplit-0.1.0.dmg` | macOS disk image, **Intel** (electron-builder omits the `x64` suffix) |
| `SubSplit-0.1.0-arm64-mac.zip` | macOS zip, Apple silicon |
| `SubSplit-0.1.0-mac.zip` | macOS zip, **Intel** |
| `SubSplit-Setup-0.1.0.exe` | Windows NSIS installer (x64 + arm64 in one) |
| `SubSplit-Portable-0.1.0-x64.exe` | Windows portable, x64 |
| `SHA256SUMS-macos.txt` | checksums for the four macOS files |
| `SHA256SUMS-windows.txt` | checksums for the two Windows files |

`build.nsis.artifactName` and `build.portable.artifactName` in `package.json` exist to keep the
Windows names free of spaces. electron-builder's defaults there are `SubSplit Setup 0.1.0.exe`
and `SubSplit 0.1.0.exe`, and GitHub accepts only `[0-9A-Za-z._-]` in an asset name — it would
rewrite them on upload, so the checksum file (written from the on-disk names) would list files
no download has. Do not drop those two patterns. The Checksums step in each job also refuses to
hash a name that is not GitHub-safe, so a regression fails the release build instead of
shipping an unverifiable installer.

The checksum lists are split per platform because each job writes its own; one shared
`SHA256SUMS.txt` would have the two jobs clobbering each other's file. Verify a download
against the matching list:

```sh
shasum -a 256 -c SHA256SUMS-macos.txt      # macOS
sha256sum -c SHA256SUMS-windows.txt        # Windows / Linux
```

Prefer the NSIS installer on Windows: Windows only delivers toasts to apps with a Start Menu
shortcut carrying the app's AppUserModelID, and the portable target does not install one.

## What people downloading this will hit

Because the builds are unsigned, both platforms will warn on first launch. Say so in the
release notes:

- **macOS** — the app is blocked on first launch. The Control-click → Open bypass no longer
  works on Sequoia (15) or Tahoe (26). Launch it, let it get blocked, then open **System
  Settings → Privacy & Security**, scroll to Security, click **Open Anyway**, confirm a second
  time, and authenticate. Once per install. On Tahoe the Open Anyway entry expires roughly an
  hour after the block, so action it promptly.
- **Windows** — SmartScreen shows "Windows protected your PC": **More info** → **Run anyway**.
  Windows **Smart App Control** blocks unsigned code outright with no per-app allow-list; users
  with SAC on cannot run these builds without turning it off.

Both caveats are covered at length in the README's "Installing an unsigned build" section —
link there from the release notes rather than restating them.

## If a job fails

Fix the problem, delete the draft release and the tag, and push the tag again:

```sh
gh release delete v0.1.0 --yes
git push --delete origin v0.1.0
git tag -d v0.1.0
```

Re-uploading over a surviving draft also works — the workflow uploads with `--clobber`.
