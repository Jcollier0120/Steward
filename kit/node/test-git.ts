import { unsignedGit } from './unsigned-git.ts';

/**
 * For a test script's `--import` alone (kit 2.71.1): `node --import=./src/kit/test-git.ts --test "<its tests>"`.
 * Every test file's git, and everything it starts, then signs no commit and no tag (unsigned-git.ts), however the person
 * has git set up. Nothing else imports it: it changes this process's environment as it loads.
 */
unsignedGit(process.env);
