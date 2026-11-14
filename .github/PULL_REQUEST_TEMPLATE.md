## What and why

What does this change, and why is it needed? Link the discussion or issue if there is one.

## Related issue

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change (existing behaviour or data changes)
- [ ] Documentation
- [ ] Chore / refactor / CI

## How it was tested

Frontend:

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`

Backend (if `src-tauri/` changed):

- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`

Manual:

- [ ] Ran the app (`npm run dev` and `npm run tauri dev`) and exercised the change
- [ ] Checked native behaviour against [docs/MAC_NATIVE_VALIDATION.md](https://github.com/Davin-X/visto-gallery/blob/main/docs/MAC_NATIVE_VALIDATION.md) (Trash, Finder tags, dialogs, drag and drop)

## Screenshots (UI changes)

Before and after, in light and dark mode.

## Checklist

- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and each one explains why
- [ ] New UI uses the design tokens in `src/design/styles/global.css` and works in light and dark mode
- [ ] New icons use the shared `Svg` component in `src/design/components/icons.tsx`
- [ ] [CHANGELOG.md](https://github.com/Davin-X/visto-gallery/blob/main/CHANGELOG.md) has a line under **Unreleased** for anything a user would notice
- [ ] New backend commands are in `generate_handler!` and wrapped in `src/engine/commands/tauri.ts`
- [ ] Migrations are added as new numbered files, never edited
- [ ] Documentation updated where behaviour or setup changed
