# Release Checklist — Chrome Web Store

Run through this list before every Web Store submission. Anything not
ticked is a blocker.

## 1. Source state

- [ ] On `main`, working tree clean (`git status` shows no unstaged
      changes).
- [ ] CHANGELOG / release notes updated for the version being shipped.
- [ ] No leftover debug branches in `src/` (`console.log`, `debugger`,
      hard-coded test paths).

## 2. Versioning

- [ ] `package.json.version` bumped.
- [ ] `manifest.json.version` matches `package.json.version`. Run:
      ```sh
      npm run release:check
      ```
      It should print `[release:check] Versions in sync (X.Y.Z).`.

## 3. Quality gates

- [ ] Lint clean:
      ```sh
      npm run lint
      ```
- [ ] Tests green:
      ```sh
      npm test
      ```
- [ ] Build clean:
      ```sh
      npm run build
      ```
      No webpack errors and no warnings about missing assets.

## 4. Manifest review

- [ ] `manifest_version` is `3`.
- [ ] `permissions` is exactly `["storage"]`. If anything else appears,
      justify it explicitly in `store/listing.md` **before** packaging.
- [ ] `host_permissions` contains only the documented Share API, Firebase
      Authentication, and Omni Viewer share-storage origins.
- [ ] `content_security_policy.extension_pages` does **not** allow
      `unsafe-eval` for scripts (only `'wasm-unsafe-eval'` is acceptable
      for the bundled audio decoder).
- [ ] `web_accessible_resources` only exposes the extension's own
      `vendor/**/*` and `templates/**/*`.
- [ ] Icons present at 16, 32, 48, 128.

## 5. Package

- [ ] Build + zip the upload artifact:
      ```sh
      npm run package
      ```
- [ ] The zip lives in `dist/omni-viewer-chrome-X.Y.Z.zip` and:
      - Does not include `node_modules/`.
      - Does not include `coverage/`, `dist/` (recursively), `.git/`,
        editor metadata, or test fixtures.
      - Includes `manifest.json`, `viewer.html`, the built `src/`
        bundles, all `templates/**/*`, all `vendor/**/*`, and the icons.

## 6. Smoke test (loaded as an unpacked extension)

- [ ] Open `chrome://extensions`, enable Developer mode, "Load unpacked"
      pointing at the unzipped artifact.
- [ ] No errors on the extension card.
- [ ] Open one file from each of the **16 viewers**: image, PDF, audio,
      video, CSV, Excel, Parquet, Word, PowerPoint, PSD, HWP, archive,
      JSON, JSONL, YAML, TOML. Each opens without console errors.
- [ ] Theme toggle persists across reloads (verifies `storage`).
- [ ] Share action uploads only after an explicit click. Confirm the copied
      web URL opens the file and expires after 5 minutes.
- [ ] Open Link accepts both the copied `/share/<id>` URL and a bare share
      ID, then routes the downloaded file through the normal viewer.

## 7. Web Store dashboard fields

- [ ] Listing name: `Omni Viewer`.
- [ ] Short description: from `store/listing.md` (English) — under 132
      characters.
- [ ] Long description: from `store/listing.md` (English) — copy verbatim.
- [ ] Listing copy explains user benefits without repeated format names,
      extension lists, search terms, or other keyword stuffing.
- [ ] 한국어 listing fields populated from the same file.
- [ ] Category: Productivity.
- [ ] Single-purpose statement: from `store/listing.md`.
- [ ] Permissions justifications: from `store/listing.md` — paste the
      `storage` justification verbatim.
- [ ] Remote code: **No, I am not using remote code.**
- [ ] Privacy policy URL: points at the published copy of
      `store/privacy.md`. Open the URL in a private window and confirm it
      loads.
- [ ] Five 1280x800 screenshots uploaded in the order from
      `store/screenshots-checklist.md`.
- [ ] Promotional / marquee tiles (if used) match the hero screenshot
      style.

## 8. Submission

- [ ] Upload the zip from step 5.
- [ ] Save the draft. Re-open and re-verify the listing fields populated.
- [ ] Submit for review.
- [ ] Tag the release in git (`git tag vX.Y.Z`).

## 9. Post-submission

- [ ] Watch the developer dashboard for review feedback.
- [ ] If rejected, capture the rejection reason verbatim into the issue
      tracker before fixing.
- [ ] On approval, announce in the project's release notes channel.
