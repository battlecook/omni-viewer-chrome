# Chrome Web Store — Screenshots Checklist

The Web Store accepts up to **five 1280x800** PNG/JPG screenshots. Capture
all five before each submission. Use a clean Chrome profile (no other
extensions visible), the **light theme**, and a sample file from
`vscode-omni-viewer/examples/` (or any equivalent fixture) so nothing
proprietary appears.

## Capture rules (apply to every shot)

- Window size: **1280 x 800** exactly. Use Chrome DevTools' Device Toolbar
  → "Responsive" → set viewport to `1280 x 800`, or set the OS window to
  that size.
- File: `.png`, sRGB, no transparency.
- Hide bookmarks bar (`Ctrl/Cmd + Shift + B`) and any developer panels.
- File names that show in the title bar should be **non-confidential**
  fixtures (e.g. `sample.png`, `report.pdf`, `metrics.csv`).
- No personal information visible (no email in profile chip, no synced
  bookmarks dropdown, no logged-in account).

Save the captured PNGs into `store/screenshots/` (gitignored). Upload them
in the order listed below — the first screenshot is the listing's hero
image.

---

## 1. Image viewer with filters

- **File**: open a colorful sample JPG/PNG (`sample.jpg`).
- **State**: image rendered, the filter sidebar visible, at least one filter
  (e.g. brightness or grayscale) applied so the difference is visible. The
  properties panel showing dimensions / file size on the right.
- **Why this shot**: demonstrates the image viewer + tooling in one frame.

## 2. PDF viewer with thumbnails and an annotation

- **File**: open a 5+ page PDF (`report.pdf`).
- **State**: thumbnail rail expanded on the left, page 2 or 3 selected, a
  text annotation visible on the page, zoom set to "Fit width".
- **Why this shot**: shows multi-page navigation, thumbnails, and the
  annotation layer all at once.

## 3. CSV viewer with sort and search

- **File**: open a CSV with at least 6 columns and 30 rows
  (`metrics.csv`).
- **State**: a column header showing the active sort indicator (descending
  preferred, more visually distinct), the search box populated with a
  filter term that visibly narrows the rows, statistics panel visible if
  it fits.
- **Why this shot**: highlights interactive table features.

## 4. Audio viewer with waveform

- **File**: open a music clip (`song.mp3` or `voice.wav`).
- **State**: waveform with a drag-selected loop region, playback in progress
  (cursor mid-track), the info panel (duration / sample rate / channels)
  and the zoom + visualization controls visible. The visualization select
  switches the stage to the spectrogram — worth a second shot if one is needed.
- **Why this shot**: visually distinctive, signals "real audio tooling".

## 5. Archive viewer with entries

- **File**: open a multi-entry zip or 7z (`bundle.zip`).
- **State**: archive entry list expanded, one entry highlighted with its
  in-archive preview rendered on the right (a small text or image entry
  works best).
- **Why this shot**: demonstrates that archives are first-class, not just
  listed.

---

## Pre-upload review

- [ ] All five PNGs are exactly 1280 x 800.
- [ ] No personal info, account chips, or other extensions visible.
- [ ] File names in title bars are public-safe fixtures.
- [ ] First screenshot (image viewer with filters) is the most visually
      striking shot — it becomes the hero.
- [ ] Saved into `store/screenshots/` and named
      `01-image.png` … `05-archive.png` for predictable ordering.
