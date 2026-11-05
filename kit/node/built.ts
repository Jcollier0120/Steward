/**
 * Whether this code is a built release (kit 2.151.0): true in what a release carries, where minify.ts's build writes
 * `true` in place of KIT_BUILT; false in a checkout run from its source, where nothing does. Nothing at run time
 * changes it, no setting and no environment variable, so what is only for development and tests (the license check
 * off under node --test, license keys added by MANOR_LICENCE_KEYS) never reaches an installed copy.
 */
declare const KIT_BUILT: boolean | undefined;

export const isBuiltRelease = (): boolean => typeof KIT_BUILT !== 'undefined' && KIT_BUILT === true;
