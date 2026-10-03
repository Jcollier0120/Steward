import { readFileSync } from 'node:fs';
import { checkRules, type Rules } from './core/index.js';

/**
 * The kit's timings and limits: the spec part's rules.json, which the node part always brings (with the
 * core), checked by the core once and handed to every core function that needs one.
 */
export const RULES: Rules = checkRules(JSON.parse(readFileSync(new URL('./spec/rules.json', import.meta.url), 'utf8').replace(/^﻿/, '')));
