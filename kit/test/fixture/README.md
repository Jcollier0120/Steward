# Fixture

The smallest agent the kit runs in, for the kit's own tests in `kit\test`. It gives the kit what every hire gives it (the agent interface, in the Steward's README): `src\app.ts`, `src\settings.ts`, `src\cli.ts`, `art\icon.svg` and `package.json`.

Its `src\kit\` is git-ignored and filled from `kit\src` by the Steward's `npm run kit`, the way a hire's is filled from a kit release. It has no `kit.json`: it always carries the kit tree it sits in.
