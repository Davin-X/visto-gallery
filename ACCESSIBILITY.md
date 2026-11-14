# Accessibility

VistoGallery should be usable by people who browse photos without a mouse, use a screen reader, or need less motion on screen. This page says what works today, what does not, and how to report a barrier.

## Our commitment

- Accessibility bugs are treated as bugs, not feature requests. They get the `accessibility` label and a normal fix, not a backlog entry.
- We would rather document a limitation honestly than claim conformance we have not verified.
- Nothing in the app is mouse-only if we can avoid it: every action reachable by pointer has a keyboard path or an alternative in a menu or dialog.

## Supported environments

- **macOS 13 or newer**, on Apple Silicon and Intel.
- **The system web view** (WebKit) that ships with macOS. The app is a Tauri build, so there is no separate browser matrix.
- **Light, dark and system themes**, plus the accent colours in Settings.
- **Reduced motion.** `prefers-reduced-motion` is honoured across the library, viewer, dialogs and shared components.
- **Screen readers.** Intended to work with VoiceOver. See the limitations below for what has and has not been tested.

Not supported: Windows, Linux, iPad, and web browsers other than the bundled app.

## What works today

**Keyboard**

- Every control is reachable with <kbd>Tab</kbd>, and focus rings are drawn on buttons, inputs, selects and textareas.
- Dialogs trap focus while open and return it to the control that opened them.
- The library grid responds to arrow keys, including moving between rows.
- <kbd>⌘</kbd> <kbd>/</kbd> lists every shortcut in the app. The main ones are in the [README](./README.md#keyboard-shortcuts).
- <kbd>Esc</kbd> closes the viewer, inspector, popover or dialog.
- Hidden items reveal on press-and-hold with the pointer; <kbd>Space</kbd> and <kbd>Enter</kbd> do the same on a focused tile.

**Screen readers**

- Icon-only buttons carry `aria-label`s, and pressed or expanded states are exposed.
- The Details view uses ARIA table roles, including headers, so rows and columns are announced.
- Sources is a real table with visually hidden captions and column headers.
- Toggle groups, tab-like controls and popovers expose their role and state.

**Vision and motion**

- Body and secondary text use separate tokens in both themes rather than one grey for everything.
- Selection, focus and hover are distinct, not colour-only: selected tiles also change their border and checkmark.
- Animations and transitions collapse when Reduce Motion is on.

## Known limitations

- **No completed VoiceOver audit.** The app has not been walked end to end with VoiceOver, so there are almost certainly unlabelled or badly ordered controls. This is the largest known gap.
- **No formal WCAG conformance claim.** The interface follows the practices above, but no audit against WCAG 2.2 AA has been done, so contrast and target sizes are best effort rather than certified.
- **No app-level text scaling.** Font sizes follow the system web view; there is no "large text" setting, and increasing display zoom is untested.
- **Increase Contrast and Reduce Transparency** are honoured only where the system web view passes them through. The custom surfaces (viewer chrome, video transport, slideshow) have not been checked with them on.
- **The video player and slideshow** use custom controls. Keyboard shortcuts work, but the timeline is not a native slider and scrubbing with VoiceOver is not implemented.
- **Drag and drop** (files onto the window, photos onto an album) has button alternatives on both paths, but the drop targets themselves are not keyboard operable.
- **Editing** (crop, rotate, exposure) is pointer-driven. Values can be typed or reset with the keyboard, but the canvas itself cannot be dragged or fine-tuned without a pointer.
- **Motion in the viewer** (zoom and pan) is not reduced by Reduce Motion; only decorative transitions are.

## Reporting a barrier

Open an issue with the `accessibility` label: [new issue](https://github.com/Davin-X/visto-gallery/issues/new?labels=accessibility). Please include:

- What you were trying to do, and where in the app.
- Your macOS version and whether VoiceOver, Voice Control, Switch Control, Increase Contrast or Reduce Motion was on.
- What happened instead: silence, the wrong element announced, focus jumping, a control you could not reach, or content you could not see.

If the issue involves private file names or thumbnails, describe them instead of pasting screenshots, or blur the images first. [SUPPORT.md](./SUPPORT.md) covers the general reporting process, and [SECURITY.md](./SECURITY.md) is the place for security problems.

## How we test

- Automated tests cover focus traps, popovers, the context menu and the video transport keyboard paths.
- Layout work is reviewed at narrow widths, where the list view compacts columns instead of hiding them.
- Accessibility is checked manually per release in the native app, which is not the same as a screen reader audit; the gap is listed above.

## Standards and references

- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) is the target we measure against, informally.
- [GitHub's accessibility statement guidance](https://opensource.guide/) shaped this page.
- Apple's [macOS accessibility features](https://support.apple.com/guide/mac-help/accessibility-mh35855/mac) are what users will have available alongside the app.
