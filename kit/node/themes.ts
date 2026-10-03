import { readFileSync } from 'node:fs';

/**
 * The manor's colour themes, from the kit's web part: web/themes.json lists them (for the Theme menu) and
 * web/themes.css has their colours, which page.ts puts in every page. Manor carries a copy of both, and its
 * Theme menu chooses the manor's theme (manor.ts reads it); Heiward and Reeve have the same nine in their own
 * files. `system` is Match Windows: no data-theme on <html>.
 *
 * page.ts needs the web part for its colours, as it does for its Settings panel: every kit agent with a page
 * takes it (kit.json's parts).
 */
export interface Theme {
  /** <html data-theme>'s value; "system" is none. */
  name: string;
  label: string;
  description: string;
  /** The page's colour, its accent and its text, for the menu's swatch. */
  swatch: [string, string, string];
  /** The menu's heading it sits under: "windows" or "colour". */
  group: string;
  /** Whether it is a light or a dark theme; null for Match Windows, which is either. */
  scheme: 'light' | 'dark' | null;
}

const LIST = new URL('./web/themes.json', import.meta.url);
const CSS = new URL('./web/themes.css', import.meta.url);

let list: { themes: Theme[]; groups: Record<string, string> } | null = null;
let css: string | null = null;

function read(file: URL): string {
  try {
    return readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    throw new Error(`The kit's web part has no ${file.pathname.split('/').pop()} (${(e as Error).message}): an agent's page needs the web part (kit.json's parts).`);
  }
}

/** The nine themes, in the menu's order: Match Windows, Light and Dark, then the colour themes. */
export function themes(): Theme[] {
  list ??= JSON.parse(read(LIST));
  return list!.themes;
}

/** The menu's heading for a group ("Windows", "Colour themes"). */
export const groupLabel = (group: string) => {
  themes();
  return list!.groups[group] ?? group;
};

/** Every theme's colours: the stylesheet page.ts puts in each page. */
export function themesCss(): string {
  css ??= read(CSS);
  return css;
}

/** The theme by this name, or null; "system" (Match Windows) is a theme too. */
export const themeNamed = (name: unknown): Theme | null => (typeof name === 'string' && themes().find((t) => t.name === name)) || null;
