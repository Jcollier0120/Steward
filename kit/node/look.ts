/**
 * A little character per agent, kept here by its id as work.ts keeps its work: page.ts draws every kit agent's
 * page the same way (Heiward's look, Windows 11's colours) and adds, from this table:
 * - **its colour** (`accent`, for Light and Dark), for its scene. Every kit agent's icon is drawn in the
 *   manor's one ink (#4a3a8a on #ebe7f8, #b9a9f5 on #221d38 at night), which the scenes take for their
 *   outlines (--ink, --ink-soft); each role's own colour comes from what its icon shows: the Aletaster's
 *   tankard holds amber ale, the Miller's windmill grinds golden grain, the Herald's banner is heraldic red;
 * - **what it is doing** while a round runs (`busy`), on the title bar's status pill: "Tasting";
 * - **its scene** in the title bar, about 64 × 40 px of inline SVG: the Aletaster's glasses of ale, the
 *   Miller's millstone. It sits still while the agent is idle, and moves only while a round runs (and never
 *   for someone who asks Windows for less motion: page.ts's CSS stops it, leaving the still frame).
 *
 * An agent that isn't listed (a new one, before it has a scene) gets DEFAULT_LOOK: a quiet grey cog.
 *
 * The scenes use page.ts's colours by class: sc-line (an ink outline), sc-back (ink outline on the icon's
 * pale fill), sc-front (ink), sc-role (the role's colour), sc-soft (a pale wash of it, ink outline),
 * sc-role-line (a line in the role's colour), sc-ground. `motion` is the scene's CSS, applied only while
 * busy (page.ts scopes it under `.titlebar.busy`). Its animations last a whole fraction of 12 seconds and
 * start from `--phase`, set from the clock as the page loads, so a busy page that reloads itself every few
 * seconds carries on where it was instead of starting over.
 */
export interface Look {
  /** The role's own colour, for its scene, on a light page and a dark one. */
  accent: { light: string; dark: string };
  /** The status pill while a round runs: what it is doing, in a word or three. */
  busy: string;
  /** The scene: SVG content for a 0 0 64 40 viewBox, drawn still. */
  scene: string;
  /** The scene's motion: CSS rules and keyframes, each rule under `.titlebar.busy .scene`. */
  motion: string;
}

const B = '.titlebar.busy .scene';
const r1 = (n: number) => Math.round(n * 10) / 10;
/** An animation that keeps time with the clock across reloads (--phase), `delay` seconds into its cycle. */
const run = (name: string, seconds: number, delay = 0, timing = 'linear') =>
  `animation: ${name} ${seconds}s ${timing} calc(var(--phase, 0s) - ${delay}s) infinite;`;
const GROUND = '<path class="sc-ground" d="M2 35.5h60"/>';

/** Bounces between `from`% and `to`% of a cycle: `n` hops of `height` px, still otherwise. */
function hops(name: string, from: number, to: number, n: number, height: number): string {
  const step = (to - from) / n;
  const frames = [`0%, ${from}% { transform: translateY(0); }`];
  for (let i = 0; i < n; i++) frames.push(`${r1(from + step * (i + 0.5))}% { transform: translateY(-${height}px); }`, `${r1(from + step * (i + 1))}% { transform: translateY(0); }`);
  frames.push('100% { transform: translateY(0); }');
  return `@keyframes ${name} { ${frames.join(' ')} }`;
}

/* ---- The Aletaster: glasses of ale, drunk one after another as the tasting goes on, then poured again. */
const GLASSES = [6, 26, 46];
const ALE_SIP: [number, number][] = [[6, 24], [33, 51], [60, 78]];
const glass = (i: number, x: number) => `<g class="sc-glass sc-g${i}">
<clipPath id="kit-sc-glass${i}"><path d="M${x} 13h12l-1.2 21h-9.6z"/></clipPath>
<path class="sc-glass-back" d="M${x} 13h12l-1.2 21h-9.6z"/>
<g clip-path="url(#kit-sc-glass${i})"><g class="sc-ale sc-a${i}">
<rect class="sc-role" x="${x - 1}" y="17" width="14" height="18"/>
<path class="sc-foam" d="M${x - 1} 18.6v-3.2q1.75-2.4 3.5 0t3.5 0t3.5 0t3.5 0v3.2z"/>
<circle class="sc-bubble sc-b1" cx="${x + 4}" cy="31" r=".7"/><circle class="sc-bubble sc-b2" cx="${x + 8}" cy="28" r=".55"/>
</g></g>
<path class="sc-glass-line" d="M${x} 13h12l-1.2 21h-9.6z"/>
<path class="sc-shine" d="M${x + 2.3} 16.5v13.5"/>
</g>`;
const aletaster: Look = {
  accent: { light: '#b35f0c', dark: '#f6b04e' },
  busy: 'Tasting',
  scene: `${GROUND}${GLASSES.map((x, i) => glass(i + 1, x)).join('')}`,
  motion: [
    ...GLASSES.map((x, i) => {
      const [s, e] = ALE_SIP[i];
      return `@keyframes sc-ale${i + 1} { 0%, ${s}% { transform: translateY(0); } ${e}%, 88% { transform: translateY(22px); } 96%, 100% { transform: translateY(0); } }
@keyframes sc-sip${i + 1} { 0%, ${s - 3}% { transform: none; } ${s + 2}%, ${e - 2}% { transform: translate(1px, -3px) rotate(-14deg); } ${e + 3}%, 100% { transform: none; } }
${B} .sc-a${i + 1} { ${run(`sc-ale${i + 1}`, 6, 0, 'ease-in-out')} }
${B} .sc-g${i + 1} { transform-origin: ${x + 6}px 34px; ${run(`sc-sip${i + 1}`, 6, 0, 'ease-in-out')} }`;
    }),
    '@keyframes sc-rise { 0% { transform: translateY(0); opacity: 0; } 25% { opacity: .9; } 100% { transform: translateY(-13px); opacity: 0; } }',
    `${B} .sc-b1 { ${run('sc-rise', 1.5)} } ${B} .sc-b2 { ${run('sc-rise', 1.5, 0.7)} }`,
  ].join('\n'),
};

/* ---- The Miller: grain falls from the hopper into the eye of the turning millstone; the flour heap grows. */
const furrows = (() => {
  const d: string[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    const p = (r: number, t: number) => `${r1(32 + r * Math.cos(t))} ${r1(24 + r * Math.sin(t))}`;
    d.push(`M${p(3.6, a)}L${p(10.4, a + 0.52)}`, `M${p(6.4, a + 0.52)}L${p(10.4, a + 0.86)}`);
  }
  return d.join('');
})();
const miller: Look = {
  accent: { light: '#8c6d00', dark: '#e2c25a' },
  busy: 'At the mill',
  scene: `${GROUND}<path class="sc-back" d="M24.5 2h15l-5 6h-5z"/><path class="sc-line" d="M32 8v2.5"/>
<g class="sc-stone"><circle class="sc-soft" cx="32" cy="24" r="11.3"/><path class="sc-role-line" d="${furrows}"/><circle class="sc-back" cx="32" cy="24" r="2.6"/></g>
<ellipse class="sc-grain sc-gr1" cx="32" cy="10.5" rx="1" ry="1.3"/><ellipse class="sc-grain sc-gr2" cx="32" cy="10.5" rx="1" ry="1.3"/><ellipse class="sc-grain sc-gr3" cx="32" cy="10.5" rx="1" ry="1.3"/>
<path class="sc-flour" d="M45 35.5c1.6-5.4 12.4-5.4 14 0z"/>`,
  motion: `@keyframes sc-turn { to { transform: rotate(360deg); } }
@keyframes sc-fall { 0% { transform: translateY(0); opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } 100% { transform: translateY(11px); opacity: 0; } }
@keyframes sc-heap { from { transform: scaleY(.82); } to { transform: scaleY(1.06); } }
${B} .sc-stone { transform-origin: 32px 24px; ${run('sc-turn', 6)} }
${B} .sc-grain { ${run('sc-fall', 1, 0, 'ease-in')} } ${B} .sc-gr2 { animation-delay: calc(var(--phase, 0s) - .33s); } ${B} .sc-gr3 { animation-delay: calc(var(--phase, 0s) - .66s); }
${B} .sc-flour { transform-origin: 52px 35.5px; animation: sc-heap 3s ease-in-out calc(var(--phase, 0s)) infinite alternate; }`,
};

/* ---- The Porter: the gate swings open and shut; the lantern sways and flickers. */
const ARCH = 'M7 35.5V19.5a10 10 0 0 1 20 0v16z';
const porter: Look = {
  accent: { light: '#3f6280', dark: '#9dbad6' },
  busy: 'Checking the gate',
  scene: `${GROUND}<path class="sc-back" d="M3 35.5V19a14 14 0 0 1 28 0v16.5z"/><path class="sc-hole" d="${ARCH}"/>
<g class="sc-leaf"><path class="sc-soft" d="${ARCH}" vector-effect="non-scaling-stroke"/><path class="sc-line" d="M12 10.9v24.6M17 9.5v26M22 10.9v24.6M7 22h20M7 29h20" vector-effect="non-scaling-stroke"/></g>
<path class="sc-line" d="M44 35.5V6.5h10"/>
<g class="sc-lantern"><path class="sc-line" d="M53 6.5v3"/><circle class="sc-halo" cx="53" cy="15" r="6.5"/><path class="sc-front" d="M50 9.5h6l-1 2h-4z"/><rect class="sc-glow" x="50.6" y="11.5" width="4.8" height="6.5" rx="1"/><path class="sc-front" d="M50 18h6v1.6h-6z"/></g>`,
  motion: `@keyframes sc-swing { 0%, 18% { transform: scaleX(1); } 34%, 64% { transform: scaleX(.12); } 80%, 100% { transform: scaleX(1); } }
@keyframes sc-sway { 0%, 100% { transform: rotate(-7deg); } 50% { transform: rotate(7deg); } }
@keyframes sc-flicker { 0%, 100% { opacity: .2; } 30% { opacity: .42; } 55% { opacity: .26; } 80% { opacity: .38; } }
${B} .sc-leaf { transform-origin: 7px 22px; ${run('sc-swing', 6, 0, 'ease-in-out')} }
${B} .sc-lantern { transform-origin: 53px 6.5px; ${run('sc-sway', 3, 0, 'ease-in-out')} }
${B} .sc-halo { ${run('sc-flicker', 1)} }`,
};

/* ---- The Clerk: a quill writes line after line on the roll. */
function wave(x0: number, x1: number, y: number): string {
  const n = Math.floor((x1 - x0) / 2.8);
  return `M${x0} ${y}q1.4-1.8 2.8 0${'t2.8 0'.repeat(n - 1)}`;
}
const LINES: [number, number, number][] = [[12, 46, 14], [12, 46, 19.5], [12, 46, 25], [12, 36, 30.5]];
const WRITE: [number, number][] = [[0, 22], [25, 47], [50, 72], [75, 92]];
const clerk: Look = {
  accent: { light: '#3949ab', dark: '#a3abff' },
  busy: 'Writing the rolls',
  scene: `<rect class="sc-paper" x="8" y="8.5" width="44" height="25.5" rx="1"/><rect class="sc-back" x="4" y="6.5" width="5.5" height="29.5" rx="2.75"/><rect class="sc-back" x="50.5" y="6.5" width="5.5" height="29.5" rx="2.75"/>
${LINES.map(([a, b, y], i) => `<path class="sc-role-line sc-write sc-w${i + 1}" pathLength="1" d="${wave(a, b, y)}"/>`).join('')}
<g class="sc-quill" transform="translate(36 30.5)"><path class="sc-back" d="M0 0C2.5-5 8-11 14-13C12.5-7 6.5-2.5 0 0z"/><path class="sc-line" d="M0 0L9.5-8.5"/></g>`,
  motion: `${WRITE.map(([s, e], i) => `@keyframes sc-write${i + 1} { 0%, ${s}% { stroke-dashoffset: 1.03; } ${e}%, 100% { stroke-dashoffset: 0; } }
${B} .sc-w${i + 1} { stroke-dasharray: 1 1.05; ${run(`sc-write${i + 1}`, 6)} }`).join('\n')}
@keyframes sc-pen { ${LINES.map(([a, b, y], i) => `${WRITE[i][0]}% { transform: translate(${a}px, ${y}px); } ${WRITE[i][1]}% { transform: translate(${b}px, ${y}px); }`).join(' ')} 100% { transform: translate(36px, 30.5px); } }
${B} .sc-quill { ${run('sc-pen', 6)} }`,
};

/* ---- The Herald: the trumpet sounds, and the banner on it flutters. */
const herald: Look = {
  accent: { light: '#b4233f', dark: '#ff8fa3' },
  busy: 'Gathering the news',
  scene: `<g class="sc-horn"><path class="sc-front" d="M4 9.6h2.4v3.6H4z"/><rect class="sc-front" x="6.4" y="10.6" width="31" height="1.6" rx=".6"/><path class="sc-front" d="M37 10.4c5 0 9-2.4 12.5-6.4v14.8c-3.5-4-7.5-6.4-12.5-6.4z"/>
<g class="sc-banner"><path class="sc-line" d="M14 12.2v1.4M32 12.2v1.4"/><path class="sc-role" d="M13 13.4h20v13l-10 7-10-7z"/><path class="sc-motif" d="M23 17.2l3.2 4.4-3.2 4.4-3.2-4.4z"/></g></g>
<path class="sc-role-line sc-wave sc-v1" d="M52.5 7.4q3 4 0 8"/><path class="sc-role-line sc-wave sc-v2" d="M56 5.2q4.6 6.2 0 12.4"/><path class="sc-role-line sc-wave sc-v3" d="M59.5 3q6.2 8.4 0 16.8"/>`,
  motion: `@keyframes sc-flutter { 0%, 100% { transform: skewX(0deg) scaleX(1); } 25% { transform: skewX(-7deg) scaleX(.96); } 50% { transform: skewX(2deg) scaleX(1); } 75% { transform: skewX(6deg) scaleX(1.03); } }
@keyframes sc-blow { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(-3deg); } }
@keyframes sc-sound { 0% { opacity: 0; transform: translateX(-2px); } 30% { opacity: 1; } 100% { opacity: 0; transform: translateX(2px); } }
${B} .sc-banner { transform-origin: 23px 13.4px; ${run('sc-flutter', 1.5, 0, 'ease-in-out')} }
${B} .sc-horn { transform-origin: 5px 11.4px; ${run('sc-blow', 3, 0, 'ease-in-out')} }
${B} .sc-wave { ${run('sc-sound', 1.5)} } ${B} .sc-v2 { animation-delay: calc(var(--phase, 0s) - 1.25s); } ${B} .sc-v3 { animation-delay: calc(var(--phase, 0s) - 1s); }`,
};

/* ---- The developer Herald: the Herald's trumpet and banner, in its own colour, for the upstream projects' releases. */
const developerHerald: Look = { ...herald, accent: { light: '#6a3fa0', dark: '#c5a3f5' }, busy: 'Reading release notes' };

/* ---- The Warrener: two rabbits hop across the grass and into the burrow. */
const rabbit = `<ellipse class="sc-role" cx="0" cy="-3.6" rx="4.4" ry="3.4"/><circle class="sc-role" cx="4" cy="-6.6" r="2.3"/>
<ellipse class="sc-role" cx="3.1" cy="-10.4" rx=".9" ry="2.6" transform="rotate(-12 3.1 -10.4)"/><ellipse class="sc-role" cx="4.9" cy="-10.2" rx=".9" ry="2.6" transform="rotate(14 4.9 -10.2)"/>
<circle class="sc-tail" cx="-4.2" cy="-4.4" r="1.3"/><circle class="sc-front" cx="4.9" cy="-7" r=".45"/>`;
const BUNNIES: { x: number; to: number; hop: [number, number] }[] = [
  { x: 8, to: 41, hop: [8, 56] },
  { x: 21, to: 28, hop: [36, 72] },
];
const warrener: Look = {
  accent: { light: '#8a5a2b', dark: '#d8a878' },
  busy: 'Tending the warren',
  scene: `${GROUND}<path class="sc-soft" d="M37.5 35.5c3-9.5 20-9.5 23 0z"/><ellipse class="sc-hole" cx="49" cy="33" rx="4.4" ry="2.7"/><path class="sc-line" d="M5 35.5l1-2.6 1 2.6M15.5 35.5l1-2.2 1 2.2M31 35.5l1-2.6 1 2.6"/>
${BUNNIES.map((b, i) => `<g class="sc-run sc-r${i + 1}"><g class="sc-hop sc-h${i + 1}"><g transform="translate(${b.x} 35.5)">${rabbit}</g></g></g>`).join('')}`,
  motion: BUNNIES.map((b, i) => {
    const [s, e] = b.hop;
    return `@keyframes sc-run${i + 1} { 0% { transform: translateX(0); opacity: 0; } 5%, ${s}% { transform: translateX(0); opacity: 1; } ${e}% { transform: translateX(${b.to}px) scale(1); opacity: 1; } ${e + 7}%, 100% { transform: translateX(${b.to}px) scale(.3); opacity: 0; } }
${hops(`sc-hop${i + 1}`, s, e, 6, 5)}
${B} .sc-r${i + 1} { transform-origin: ${b.x}px 35px; ${run(`sc-run${i + 1}`, 6)} }
${B} .sc-h${i + 1} { ${run(`sc-hop${i + 1}`, 6)} }`;
  }).join('\n'),
};

/** A sheep standing on y = 0, facing right (the Pinder's stray; the Shepherd's, turned about, face left). */
const sheep = `<path class="sc-line" d="M-3 0v-3.6M3 0v-3.6"/><path class="sc-wool" d="M-5.5-6.5c0-2.6 1.6-3.9 3-3.9.6-1 2.4-1.4 3.4-.4 1.5-.6 3.6.4 3.6 2 1.6.4 1.8 2.6.6 3.4.4 1.8-1 3-2.6 2.8-1 1-3 1-4 .1-1.8.3-3.3-.6-3.2-2.1-.6-.4-.8-1.2-.8-1.9z"/><ellipse class="sc-front" cx="5.6" cy="-8.2" rx="2.1" ry="1.6"/>`;

/* ---- The Pinder: a stray walks into the pound, the gate shuts behind it, and the lock goes on. */
const pinder: Look = {
  accent: { light: '#3b7d1f', dark: '#8fd36f' },
  busy: 'Looking for strays',
  scene: `${GROUND}<g class="sc-walk"><g class="sc-bob"><g transform="translate(10 35.5)">${sheep}</g></g></g>
<path class="sc-front" d="M34 20h2.2v15.5H34zM44 20h2.2v15.5H44zM53 20h2.2v15.5H53zM61.4 20h2.2v15.5h-2.2z"/><path class="sc-line" d="M46.2 24h15.2M46.2 30h15.2"/>
<g class="sc-gate"><path class="sc-role-line sc-rails" d="M36.2 24H44M36.2 30H44M36.6 30l7-6" vector-effect="non-scaling-stroke"/></g>
<g class="sc-lock"><path class="sc-line" d="M38.4 26.4V25a1.6 1.6 0 0 1 3.2 0v1.4"/><rect class="sc-role" x="37.8" y="26.4" width="4.4" height="3.6" rx=".7"/></g>`,
  motion: `@keyframes sc-walk { 0% { transform: translateX(0); opacity: 0; } 6% { opacity: 1; } 52%, 90% { transform: translateX(43px); opacity: 1; } 98%, 100% { transform: translateX(43px); opacity: 0; } }
${hops('sc-bob', 0, 52, 10, 0.9)}
@keyframes sc-gate { 0%, 18% { transform: scaleX(1); } 30%, 46% { transform: scaleX(.1); } 58%, 100% { transform: scaleX(1); } }
@keyframes sc-lock { 0%, 60% { opacity: 0; transform: translateY(-2px); } 66%, 92% { opacity: 1; transform: translateY(0); } 98%, 100% { opacity: 0; } }
${B} .sc-walk { ${run('sc-walk', 6)} }
${B} .sc-bob { ${run('sc-bob', 6)} }
${B} .sc-gate { transform-origin: 44px 27px; ${run('sc-gate', 6, 0, 'ease-in-out')} }
${B} .sc-lock { ${run('sc-lock', 6)} }`,
};

/* ---- The Auditor: a tally stick notched, one cut at a time. */
const NOTCHES = [11, 17, 23, 29, 35, 41, 47, 53];
const auditor: Look = {
  accent: { light: '#0e7470', dark: '#5fcfc5' },
  busy: 'Checking the accounts',
  scene: `<rect class="sc-wood" x="4" y="22" width="56" height="9" rx="4.5"/><path class="sc-split" d="M9 26.5h46"/>
${NOTCHES.map((x, i) => `<path class="sc-role sc-notch sc-n${i + 1}" d="${i === 4 ? `M${x - 2.2} 22.2l2.2 4.4 2.2-4.4z` : `M${x - 1.4} 22.2l1.4 3.6 1.4-3.6z`}"/>`).join('')}
<g class="sc-knife" transform="translate(57 16)"><path class="sc-steel" d="M0 0l-1.6-6.5h3.2z"/><rect class="sc-front" x="-1.3" y="-12" width="2.6" height="5.6" rx="1"/></g>`,
  motion: `${NOTCHES.map((x, i) => `@keyframes sc-notch${i + 1} { 0%, ${i * 11 + 4}% { opacity: 0; } ${i * 11 + 5}%, 100% { opacity: 1; } }
${B} .sc-n${i + 1} { ${run(`sc-notch${i + 1}`, 6, 0, 'steps(1, end)')} }`).join('\n')}
@keyframes sc-cut { ${NOTCHES.map((x, i) => `${i * 11}% { transform: translate(${x}px, 16px); } ${i * 11 + 4}% { transform: translate(${x}px, 22.4px); } ${i * 11 + 7}% { transform: translate(${x}px, 16px); }`).join(' ')} 100% { transform: translate(${NOTCHES[0]}px, 16px); } }
${B} .sc-knife { ${run('sc-cut', 6)} }`,
};

/* ---- The Steward: a ring of keys, one for every door of the house, jingling as it goes about. */
const key = `<circle class="sc-back" cx="0" cy="0" r="2.4"/><rect class="sc-role" x="-.75" y="2.2" width="1.5" height="14"/><path class="sc-role" d="M.75 12.4h2.6v1.5H.75zM.75 14.8h1.8v1.5H.75z"/>`;
const KEYS = [-30, 0, 30];
const steward: Look = {
  accent: { light: '#9c2f74', dark: '#f39ad3' },
  busy: 'Seeing to the staff',
  scene: `<path class="sc-line" d="M24 1.6h16M32 1.6v2"/><g class="sc-bunch"><circle class="sc-ring" cx="32" cy="9" r="5.5"/>
${KEYS.map((a, i) => `<g class="sc-key sc-k${i + 1}" transform="rotate(${a} 32 9)"><g transform="translate(32 14.5)">${key}</g></g>`).join('')}</g>`,
  motion: `@keyframes sc-bunch { 0%, 100% { transform: rotate(-9deg); } 50% { transform: rotate(9deg); } }
${KEYS.map((a, i) => `@keyframes sc-jingle${i + 1} { 0%, 100% { transform: rotate(${a}deg); } 30% { transform: rotate(${a + 7}deg); } 65% { transform: rotate(${a - 6}deg); } }
${B} .sc-k${i + 1} { transform-origin: 32px 9px; ${run(`sc-jingle${i + 1}`, 1, i * 0.2, 'ease-in-out')} }`).join('\n')}
${B} .sc-bunch { transform-origin: 32px 2px; ${run('sc-bunch', 2, 0, 'ease-in-out')} }`,
};

/* ---- The Surveyor: the theodolite sweeps across the estate, sighting the staff. */
const surveyor: Look = {
  accent: { light: '#0b6aa2', dark: '#6cc6f2' },
  busy: 'Surveying',
  scene: `${GROUND}<path class="sc-line" d="M30 21 20 35.5M30 21v14.5M30 21l10 14.5"/><rect class="sc-front" x="25.5" y="19" width="9" height="2.6" rx=".6"/><rect class="sc-back" x="27" y="13.5" width="6" height="5.5"/>
<g class="sc-scope"><path class="sc-sight" d="M41 12.6H55"/><rect class="sc-back" x="20" y="10.6" width="16" height="4"/><rect class="sc-front" x="36" y="10" width="3.6" height="5.2"/></g><circle class="sc-front" cx="30" cy="12.6" r="1.2"/>
<rect class="sc-staff" x="56.5" y="10" width="3.4" height="25.5"/><path class="sc-role" d="M56.5 10h3.4v4.2h-3.4zM56.5 18.4h3.4v4.2h-3.4zM56.5 26.8h3.4v4.2h-3.4z"/>`,
  motion: `@keyframes sc-sweep { 0%, 100% { transform: rotate(-12deg); } 45%, 55% { transform: rotate(0deg); } }
@keyframes sc-sight { 0%, 38% { opacity: 0; } 45%, 55% { opacity: 1; } 62%, 100% { opacity: 0; } }
${B} .sc-scope { transform-origin: 30px 12.6px; ${run('sc-sweep', 4, 0, 'ease-in-out')} }
${B} .sc-sight { ${run('sc-sight', 4)} }`,
};

/* ---- The Lamplighter: the long pole rises to the lantern, its little flame lights the lamp, and the pole comes down. */
const lamplighter: Look = {
  accent: { light: '#c4471a', dark: '#ff9a6b' },
  busy: 'Lighting the lamps',
  scene: `${GROUND}<path class="sc-line" d="M46 35.5V16.6M42.4 19.2h7.2"/><path class="sc-front" d="M42.9 34.2h6.2v1.3h-6.2z"/>
<circle class="sc-halo sc-lamp-halo" cx="46" cy="11.6" r="7.6"/>
<path class="sc-back" d="M41.6 8.6h8.8l-1.6 6.2h-5.6z"/><path class="sc-glow sc-lamp" d="M42.9 9.5h6.2l-1.1 4.3h-4z"/><path class="sc-role sc-lamp" d="M46 10c1 1.1 1.4 1.9 1.4 2.4a1.4 1.4 0 0 1-2.8 0c0-.5.4-1.3 1.4-2.4z"/>
<path class="sc-front" d="M40.6 8.9h10.8L46 4.8z"/><path class="sc-front" d="M43.2 14.6h5.6v1.5h-5.6z"/>
<g class="sc-pole" transform="rotate(16 10 35.5)"><path class="sc-line" d="M10 35.5 41.6 13.4"/><path class="sc-role sc-tip" d="M42.3 10.2c1 1.1 1.4 1.9 1.4 2.4a1.4 1.4 0 0 1-2.8 0c0-.5.4-1.3 1.4-2.4z"/></g>`,
  motion: `@keyframes sc-raise { 0%, 8% { transform: rotate(16deg); } 34%, 56% { transform: rotate(0deg); } 80%, 100% { transform: rotate(16deg); } }
@keyframes sc-light { 0%, 36% { opacity: .15; } 44%, 90% { opacity: 1; } 98%, 100% { opacity: .15; } }
@keyframes sc-glowing { 0%, 36% { opacity: 0; } 44%, 90% { opacity: .22; } 98%, 100% { opacity: 0; } }
@keyframes sc-flicker-tip { 0%, 100% { opacity: 1; } 40% { opacity: .55; } 70% { opacity: .85; } }
${B} .sc-pole { transform-origin: 10px 35.5px; ${run('sc-raise', 6, 0, 'ease-in-out')} }
${B} .sc-lamp { ${run('sc-light', 6)} }
${B} .sc-lamp-halo { ${run('sc-glowing', 6)} }
${B} .sc-tip { ${run('sc-flicker-tip', 1)} }`,
};

/* ---- The Smith: the hammer comes down on the iron on the anvil, sparks fly, and the forge behind glows. */
const smith: Look = {
  accent: { light: '#a3501c', dark: '#f0a46e' },
  busy: 'At the forge',
  scene: `${GROUND}<path class="sc-back" d="M40 35.5V20h20v15.5z"/><path class="sc-hole" d="M44 35.5v-9a6 6 0 0 1 12 0v9z"/><path class="sc-halo sc-fire" d="M45.5 35.5c0-4 2.2-5 2.6-8 1.6 1.8 1.4 3.4 1.4 3.4s1.2-1.6 1.2-3.6c2 2 3.8 4.6 3.8 8.2z"/>
<path class="sc-front" d="M8 22h22c0 2.6-2.6 4-6 4.4V30h3.2v2.4H11V30h3.6v-3.6C11 26 8.8 24.6 8 22z"/><rect class="sc-role sc-iron" x="15" y="19.6" width="11" height="2.4" rx="1"/>
<circle class="sc-glow sc-spark sc-s1" cx="19" cy="18" r=".7"/><circle class="sc-glow sc-spark sc-s2" cx="22" cy="18" r=".6"/><circle class="sc-glow sc-spark sc-s3" cx="20.5" cy="18" r=".5"/>
<g class="sc-hammer" transform="rotate(-38 33 14)"><path class="sc-line" d="M33 14 21 12.5"/><rect class="sc-steel" x="17.2" y="9.4" width="5" height="7" rx="1"/></g>`,
  motion: `@keyframes sc-strike { 0%, 40% { transform: rotate(-38deg); } 50% { transform: rotate(4deg); } 54% { transform: rotate(0deg); } 100% { transform: rotate(-38deg); } }
@keyframes sc-sparks1 { 0%, 50% { transform: translate(0, 0); opacity: 0; } 54% { opacity: 1; } 80%, 100% { transform: translate(-6px, -9px); opacity: 0; } }
@keyframes sc-sparks2 { 0%, 50% { transform: translate(0, 0); opacity: 0; } 54% { opacity: 1; } 80%, 100% { transform: translate(5px, -10px); opacity: 0; } }
@keyframes sc-sparks3 { 0%, 50% { transform: translate(0, 0); opacity: 0; } 54% { opacity: 1; } 76%, 100% { transform: translate(0, -12px); opacity: 0; } }
@keyframes sc-fire { 0%, 100% { opacity: .2; } 30% { opacity: .5; } 60% { opacity: .28; } 80% { opacity: .44; } }
${B} .sc-hammer { transform-origin: 33px 14px; ${run('sc-strike', 1.5, 0, 'ease-in')} }
${B} .sc-s1 { ${run('sc-sparks1', 1.5)} } ${B} .sc-s2 { ${run('sc-sparks2', 1.5)} } ${B} .sc-s3 { ${run('sc-sparks3', 1.5)} }
${B} .sc-fire { ${run('sc-fire', 1.5)} }`,
};

/* ---- The Thatcher: the roof is thatched course by course from the eaves up, each course patted down with the leggett. */
const COURSES: { d: string; y: number; x: [number, number]; pat: [number, number] }[] = [
  { d: 'M7 24h50l-8.4-6.4H15.4z', y: 24, x: [10, 54], pat: [44, 22] },
  { d: 'M15.4 17.6h33.2l-8.4-6.4H23.8z', y: 17.6, x: [18, 46], pat: [38, 15.6] },
  { d: 'M23.8 11.2h16.4L32 5z', y: 11.2, x: [26, 38], pat: [33.5, 10] },
];
const LAY = [4, 32, 60];
const LEGGETT: [number, number] = [51, 10];
/** The straw ends along a course's lower edge. */
const strawEnds = (x0: number, x1: number, y: number) => {
  const d: string[] = [];
  for (let x = x0; x <= x1; x += 4) d.push(`M${x} ${y}v-1.8`);
  return d.join('');
};
const thatcher: Look = {
  accent: { light: '#6b7014', dark: '#d2d66c' },
  busy: 'Mending the roof',
  scene: `${GROUND}<path class="sc-back" d="M12 35.5V24h40v11.5z"/><path class="sc-hole" d="M28 35.5V29a4 4 0 0 1 8 0v6.5z"/>
<path class="sc-back" d="M7 24h50L32 5z"/><path class="sc-line" d="M15.4 17.6h33.2M23.8 11.2h16.4"/>
${COURSES.map((c, i) => `<g class="sc-course sc-t${i + 1}"><path class="sc-soft" d="${c.d}"/><path class="sc-role-line" d="${strawEnds(c.x[0], c.x[1], c.y)}"/></g>`).join('')}
<path class="sc-soft" d="M2.5 35.5 4 27.5h5l1.5 8z"/><path class="sc-line" d="M3.4 31.2h6.2"/>
<g class="sc-leggett" transform="translate(${LEGGETT[0]} ${LEGGETT[1]})"><path class="sc-line" d="M1.5-2.6 6-8.4"/><rect class="sc-wood" x="-3.5" y="-2.6" width="7" height="2.6" rx=".6"/></g>`,
  motion: `${COURSES.map((c, i) => `@keyframes sc-lay${i + 1} { 0%, ${LAY[i]}% { opacity: 0; transform: translateY(-3px); } ${LAY[i] + 5}%, 90% { opacity: 1; transform: translateY(0); } 97%, 100% { opacity: 0; transform: translateY(0); } }
${B} .sc-t${i + 1} { ${run(`sc-lay${i + 1}`, 6, 0, 'ease-out')} }`).join('\n')}
@keyframes sc-pat { 0% { transform: translate(${LEGGETT[0]}px, ${LEGGETT[1]}px); } ${COURSES.map((c, i) => {
    const [x, y] = c.pat;
    const a = LAY[i];
    return `${a + 4}% { transform: translate(${x}px, ${y - 3}px); } ${a + 9}% { transform: translate(${x}px, ${y}px); } ${a + 13}% { transform: translate(${x}px, ${y - 3}px); } ${a + 17}% { transform: translate(${x}px, ${y}px); } ${a + 21}% { transform: translate(${x}px, ${y - 3}px); }`;
  }).join(' ')} 88%, 100% { transform: translate(${LEGGETT[0]}px, ${LEGGETT[1]}px); } }
${B} .sc-leggett { ${run('sc-pat', 6, 0, 'ease-in-out')} }`,
};

/* ---- The Reckoner: counters slid across the counting board, one at a time, from what is still to count to what is counted. */
const RECKON_ROWS = [12.5, 20, 27.5];
/** Each counter, in the order it is slid: its row, and where it goes from and to. */
const RECKON: { row: number; from: number; to: number }[] = [
  { row: 0, from: 16, to: 41 }, { row: 0, from: 11, to: 36 },
  { row: 1, from: 11, to: 36 },
  { row: 2, from: 21, to: 46 }, { row: 2, from: 16, to: 41 }, { row: 2, from: 11, to: 36 },
];
const reckoner: Look = {
  accent: { light: '#08788f', dark: '#62cfe6' },
  busy: 'Taking stock',
  scene: `<rect class="sc-wood" x="3" y="5" width="58" height="30" rx="2"/><rect class="sc-paper" x="6" y="8" width="52" height="24" rx=".8"/>
<path class="sc-line" d="${RECKON_ROWS.map((y) => `M8 ${y}h48`).join('')}"/><path class="sc-split" d="M31 9v22"/>
${RECKON.map((c, i) => `<circle class="sc-role sc-counter sc-c${i + 1}" cx="${c.from}" cy="${RECKON_ROWS[c.row]}" r="2.3"/>`).join('')}`,
  motion: RECKON.map((c, i) => {
    const s = 4 + i * 13;
    return `@keyframes sc-slide${i + 1} { 0%, ${s}% { transform: translateX(0); } ${s + 9}%, 86% { transform: translateX(${c.to - c.from}px); } 96%, 100% { transform: translateX(0); } }
${B} .sc-c${i + 1} { ${run(`sc-slide${i + 1}`, 6, 0, 'ease-in-out')} }`;
  }).join('\n'),
};

/* ---- The Weigher: a load drops into one pan, the beam tips, swings, and settles level. */
const pan = (x: number, load: string) => `<path class="sc-line" d="M${x} 9 ${x - 5} 22M${x} 9l5 13"/>${load}<path class="sc-soft" d="M${x + 7} 22a7 4.5 0 0 1-14 0z"/>`;
const TIP = [[0, 0], [10, 0], [18, -10], [30, 6], [41, -3.5], [51, 2], [60, -0.8], [68, 0], [100, 0]];
const weigher: Look = {
  accent: { light: '#137a52', dark: '#5fd4a0' },
  busy: 'Weighing',
  scene: `${GROUND}<path class="sc-front" d="M24 35.5h16l-2.5-3h-11z"/><rect class="sc-front" x="31" y="9" width="2" height="23.6"/>
<g class="sc-beam"><path class="sc-front" d="M10 8.2h44v1.6H10z"/><circle class="sc-back" cx="32" cy="9" r="1.9"/>
<g class="sc-pan sc-pan-l">${pan(11, '<path class="sc-role sc-load" d="M8 22c0-3 1.6-4.6 2.5-5.2-.6-.6-.4-1.5.5-1.5s1.1.9.5 1.5c.9.6 2.5 2.2 2.5 5.2z"/>')}</g>
<g class="sc-pan sc-pan-r">${pan(53, '<path class="sc-front" d="M49.5 22v-2.6h7V22zM51 19.4v-2.2h4v2.2z"/>')}</g></g>`,
  motion: `@keyframes sc-tip { ${TIP.map(([p, a]) => `${p}% { transform: rotate(${a}deg); }`).join(' ')} }
@keyframes sc-hang { ${TIP.map(([p, a]) => `${p}% { transform: rotate(${-a}deg); }`).join(' ')} }
@keyframes sc-drop { 0% { transform: translateY(-9px); opacity: 0; } 4% { opacity: 1; } 10%, 90% { transform: translateY(0); opacity: 1; } 97%, 100% { transform: translateY(0); opacity: 0; } }
${B} .sc-beam { transform-origin: 32px 9px; ${run('sc-tip', 6, 0, 'ease-in-out')} }
${B} .sc-pan-l { transform-origin: 11px 9px; ${run('sc-hang', 6, 0, 'ease-in-out')} }
${B} .sc-pan-r { transform-origin: 53px 9px; ${run('sc-hang', 6, 0, 'ease-in-out')} }
${B} .sc-load { ${run('sc-drop', 6, 0, 'ease-in')} }`,
};

/* ---- The Shepherd: the crook, in front, walks a sheep the other way from the Pinder's, into the stone fold where another waits. */
const shepherd: Look = {
  accent: { light: '#7a3eb3', dark: '#c9a2f3' },
  busy: 'Bringing them in',
  scene: `${GROUND}<path class="sc-soft" d="M1 35.5V29c0-2.8 5-4.4 14-4.4S29 26.2 29 29v6.5z"/><rect class="sc-front" x="27.6" y="25.6" width="2.4" height="9.9"/>
<g transform="translate(9 35.5) scale(-1 1)">${sheep}</g>
<g class="sc-walk"><g class="sc-bob"><g transform="translate(48 35.5) scale(-1 1)">${sheep}</g></g></g>
<rect class="sc-back" x="1" y="30.9" width="6.6" height="4.6" rx="1.5"/><rect class="sc-back" x="8.4" y="30.9" width="6.6" height="4.6" rx="1.5"/><rect class="sc-back" x="15.8" y="30.9" width="6.6" height="4.6" rx="1.5"/>
<g class="sc-crook"><g class="sc-nudge"><path class="sc-role-line" d="M57 35.5V11a3.5 3.5 0 0 0-7 0v2"/></g></g>`,
  motion: `@keyframes sc-walk { 0% { transform: translateX(0); opacity: 0; } 6% { opacity: 1; } 55%, 88% { transform: translateX(-28px); opacity: 1; } 96%, 100% { transform: translateX(-28px); opacity: 0; } }
${hops('sc-bob', 0, 55, 10, 0.9)}
@keyframes sc-follow { 0% { transform: translateX(0); } 55% { transform: translateX(-26px); } 64% { transform: translateX(-26px); } 92%, 100% { transform: translateX(0); } }
@keyframes sc-nudge { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(-7deg); } }
${B} .sc-walk { ${run('sc-walk', 6)} }
${B} .sc-bob { ${run('sc-bob', 6)} }
${B} .sc-crook { ${run('sc-follow', 6, 0, 'ease-in-out')} }
${B} .sc-nudge { transform-origin: 57px 35.5px; ${run('sc-nudge', 1.5, 0, 'ease-in-out')} }`,
};

/* ---- Reeve: the log scrolls up through the amber reading line, and the day's count is kept in gate tallies, four bars and a strike. */
const LOG_LINES = [14, 9, 16, 11, 7, 15];
/** The log's lines, 4.5 px apart and twice over, so that scrolling one pattern's height up comes back to where it began. */
const logLines = [...LOG_LINES, ...LOG_LINES, ...LOG_LINES.slice(0, 3)].map((w, i) => `M6.5 ${r1(9 + i * 4.5)}h${w}`).join('');
/** The two gates' strokes, in the order they are cut: four bars, then the strike across them. */
const TALLY = [29, 46].flatMap((x) => [
  ...[0, 3.5, 7, 10.5].map((dx) => `M${x + dx} 13v16`),
  `M${x - 2.5} 26.5L${x + 13} 15.5`,
]);
const reeve: Look = {
  accent: { light: '#9a5b00', dark: '#f5b84b' },
  busy: 'Reading the logs',
  scene: `<clipPath id="kit-sc-reeve-log"><rect x="4" y="7" width="20" height="26"/></clipPath>
<rect class="sc-paper" x="3" y="5.5" width="22" height="29" rx="1"/><rect class="sc-halo" x="3.6" y="18" width="20.8" height="4.2"/>
<g clip-path="url(#kit-sc-reeve-log)"><path class="sc-line sc-log" d="${logLines}"/></g>
<g class="sc-tally">${TALLY.map((d, i) => `<path class="sc-role-line sc-cut sc-u${i + 1}" pathLength="1" d="${d}"/>`).join('')}</g>`,
  motion: `@keyframes sc-scroll { to { transform: translateY(-27px); } }
@keyframes sc-tally { 0%, 90% { opacity: 1; } 96%, 100% { opacity: 0; } }
${TALLY.map((d, i) => `@keyframes sc-cut${i + 1} { 0%, ${4 + i * 8}% { stroke-dashoffset: 1.03; } ${9 + i * 8}%, 100% { stroke-dashoffset: 0; } }
${B} .sc-u${i + 1} { stroke-dasharray: 1 1.05; ${run(`sc-cut${i + 1}`, 6, 0, 'ease-out')} }`).join('\n')}
${B} .sc-log { ${run('sc-scroll', 6)} }
${B} .sc-tally { ${run('sc-tally', 6)} }`,
};

/* ---- The Chamberlain: a letter is sealed in red wax, the keyhole pressed in it, and filed in its pigeonhole; the next one comes. */
const HOLES: [number, number][] = [[39.5, 8.5], [50, 8.5], [39.5, 17.5], [50, 17.5], [39.5, 26.5], [50, 26.5]];
/** The papers already filed, peeking out of their holes, by hole; the last is the one the letter goes into. */
const FILED = [0, 3, 4, 5];
const chamberlain: Look = {
  accent: { light: '#7a1d2c', dark: '#eea4ae' },
  busy: 'Filing your papers',
  scene: `${GROUND}<rect class="sc-wood" x="37" y="6" width="24" height="29.5" rx="1"/>
${HOLES.map(([x, y]) => `<rect class="sc-hole" x="${x}" y="${y}" width="9" height="7" rx=".6"/>`).join('')}
${FILED.map((h, i) => `<rect class="sc-paper${i === FILED.length - 1 ? ' sc-filed' : ''}" x="${HOLES[h][0] + 1}" y="${HOLES[h][1] + 2.6}" width="7" height="4.4" rx=".3"/>`).join('')}
<g class="sc-letter"><rect class="sc-paper" x="5" y="22" width="22" height="13.5" rx="1"/><path class="sc-line" d="M5.8 23 16 30.2 26.2 23"/>
<g class="sc-seal"><circle class="sc-role" cx="16" cy="30" r="3.3"/><circle class="sc-motif" cx="16" cy="29.3" r=".9"/><path class="sc-motif" d="M15.55 29.8h.9l.35 2.1h-1.6z"/></g></g>
<g class="sc-stamp"><rect class="sc-wood" x="13.5" y="5" width="5" height="7.5" rx="2.5"/><rect class="sc-front" x="15" y="12.5" width="2" height="3"/><rect class="sc-front" x="12.8" y="15.5" width="6.4" height="2.2" rx=".6"/></g>`,
  motion: `@keyframes sc-stamp { 0%, 4% { transform: translateY(0); } 11%, 15% { transform: translateY(9.5px); } 22%, 100% { transform: translateY(0); } }
@keyframes sc-seal { 0%, 12% { opacity: 0; } 13%, 60% { opacity: 1; } 61%, 100% { opacity: 0; } }
@keyframes sc-file { 0%, 26% { transform: translate(0, 0) scale(1); opacity: 1; } 54% { transform: translate(38.5px, 1.25px) scale(.32); opacity: 1; } 58%, 80% { transform: translate(38.5px, 1.25px) scale(.32); opacity: 0; } 81% { transform: translate(0, -4px) scale(1); opacity: 0; } 90%, 100% { transform: translate(0, 0) scale(1); opacity: 1; } }
@keyframes sc-filed { 0%, 54% { opacity: 0; } 57%, 92% { opacity: 1; } 98%, 100% { opacity: 0; } }
${B} .sc-stamp { ${run('sc-stamp', 6, 0, 'ease-in-out')} }
${B} .sc-seal { ${run('sc-seal', 6, 0, 'steps(1, end)')} }
${B} .sc-letter { transform-origin: 16px 28.75px; ${run('sc-file', 6, 0, 'ease-in-out')} }
${B} .sc-filed { ${run('sc-filed', 6)} }`,
};

/* ---- Heiward: the shears go along the hedge, snipping each sprig that has grown out of it; they fall, and the hedge stands trim. */
const SPRIGS = [37, 28, 19, 10];
/** When the shears reach each sprig, in % of the cycle, right to left; each snip comes 4% after. */
const SNIP = [8, 26, 44, 62];
const SHEARS: [number, number] = [50, 12];
const blade = `<path class="sc-steel" d="M1.2 0-8 -2-8.4-.6 0 .9z"/><path class="sc-line" d="M0 0 4.6-2.4"/><circle class="sc-back" cx="6" cy="-3.2" r="1.6"/>`;
const heiward: Look = {
  accent: { light: '#0f7b3f', dark: '#6ccb8f' },
  busy: 'Trimming the hedges',
  scene: `${GROUND}<path class="sc-line" d="M50 25h13.5M50 31h13.5"/>${[51, 56, 61].map((x) => `<path class="sc-wood" d="M${x - 1.3} 35.5V21.6l1.3-1.8 1.3 1.8v13.9z"/>`).join('')}
<path class="sc-soft" d="M3 35.5V21${'a3.2 3.2 0 0 1 6 0'.repeat(7)}V35.5z"/>
${[[8, 27], [16, 31], [23, 25.5], [31, 30], [38, 25.5]].map(([x, y]) => `<path class="sc-role" d="M${x} ${y}c-.2-2 1-3.4 3-3.5.2 2-1.1 3.4-3 3.5z"/>`).join('')}
${SPRIGS.map((x, i) => `<g class="sc-sprig sc-p${i + 1}"><path class="sc-role-line" d="M${x} 20q-.6-3 .8-6.4"/><path class="sc-role" d="M${x + 0.8} 14.4c-.3-2.4 1.1-4 3.4-4.2.2 2.4-1.2 4-3.4 4.2z"/><path class="sc-role" d="M${x - 0.1} 17.6c-2-.1-3.2-1.4-3.2-3.3 2 .1 3.2 1.4 3.2 3.3z"/></g>`).join('')}
<g class="sc-shears" transform="translate(${SHEARS[0]} ${SHEARS[1]})"><g class="sc-blade sc-bl1">${blade}</g><g class="sc-blade sc-bl2"><g transform="scale(1 -1)">${blade}</g></g><circle class="sc-front" cx="0" cy="0" r=".9"/></g>`,
  motion: `@keyframes sc-shears { 0% { transform: translate(${SHEARS[0]}px, ${SHEARS[1]}px); } ${SPRIGS.map((x, i) => `${SNIP[i]}%, ${SNIP[i] + 8}% { transform: translate(${x + 6}px, 15.5px); }`).join(' ')} 84%, 100% { transform: translate(${SHEARS[0]}px, ${SHEARS[1]}px); } }
@keyframes sc-open1 { 0% { transform: rotate(0deg); } ${SNIP.map((s) => `${s - 3}%, ${s + 1}% { transform: rotate(-16deg); } ${s + 4}% { transform: rotate(0deg); } ${s + 7}% { transform: rotate(-16deg); }`).join(' ')} 80%, 100% { transform: rotate(0deg); } }
@keyframes sc-open2 { 0% { transform: rotate(0deg); } ${SNIP.map((s) => `${s - 3}%, ${s + 1}% { transform: rotate(16deg); } ${s + 4}% { transform: rotate(0deg); } ${s + 7}% { transform: rotate(16deg); }`).join(' ')} 80%, 100% { transform: rotate(0deg); } }
${SPRIGS.map((x, i) => `@keyframes sc-fall${i + 1} { 0%, ${SNIP[i] + 4}% { transform: translate(0, 0) rotate(0deg); opacity: 1; } ${SNIP[i] + 12}% { transform: translate(-2px, 14px) rotate(-50deg); opacity: 1; } ${SNIP[i] + 16}%, 92% { transform: translate(-2px, 14px) rotate(-50deg); opacity: 0; } 93% { transform: translate(0, 0) rotate(0deg); opacity: 0; } 100% { transform: translate(0, 0) rotate(0deg); opacity: 1; } }
${B} .sc-p${i + 1} { transform-origin: ${x}px 20px; ${run(`sc-fall${i + 1}`, 6, 0, 'ease-in')} }`).join('\n')}
${B} .sc-shears { ${run('sc-shears', 6, 0, 'ease-in-out')} }
${B} .sc-bl1 { transform-origin: 0 0; ${run('sc-open1', 6)} }
${B} .sc-bl2 { transform-origin: 0 0; ${run('sc-open2', 6)} }`,
};

/* ---- The Toller: a coin drops into the box, the striped bar lifts to let what came through pass, and comes down again. */
const toller: Look = {
  accent: { light: '#a8641a', dark: '#e8c27a' },
  busy: 'Checking the gate',
  scene: `${GROUND}<rect class="sc-wood" x="6" y="15" width="7" height="20.5" rx="1"/><rect class="sc-back" x="4.5" y="25" width="10" height="6" rx=".8"/><path class="sc-line" d="M7.5 25v-1.5h4V25"/>
<g class="sc-bar"><rect class="sc-back" x="11" y="17" width="49" height="5" rx="2.5"/>${[18, 28, 38, 48].map((x) => `<path class="sc-role" d="M${x} 17.2h4l-2.6 4.6h-4z"/>`).join('')}</g>
<g class="sc-coin"><circle class="sc-role" cx="9.5" cy="7" r="3"/><path class="sc-line" d="M9.5 5.6v2.8"/></g>`,
  motion: `@keyframes sc-coin { 0%, 4% { transform: translateY(0); opacity: 1; } 18% { transform: translateY(16px); opacity: 1; } 20%, 90% { transform: translateY(16px); opacity: 0; } 92% { transform: translateY(0); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
@keyframes sc-lift { 0%, 20% { transform: rotate(0deg); } 32%, 62% { transform: rotate(-24deg); } 76%, 100% { transform: rotate(0deg); } }
${B} .sc-coin { ${run('sc-coin', 6, 0, 'ease-in')} }
${B} .sc-bar { transform-origin: 13.5px 19.5px; ${run('sc-lift', 6, 0, 'ease-in-out')} }`,
};

/* ---- The Assayer: the balance tips as an ingot is weighed against the other pan, settles, and is weighed again. */
const assayer: Look = {
  accent: { light: '#7d6a12', dark: '#e8cc7a' },
  busy: 'Testing the work',
  scene: `${GROUND}<path class="sc-line" d="M32 9v24.5"/><rect class="sc-front" x="25" y="33" width="14" height="2.5" rx=".5"/><circle class="sc-front" cx="32" cy="8.5" r="1.6"/>
<g class="sc-beam"><path class="sc-line" d="M14 11h36"/>
<g class="sc-pan sc-pl"><path class="sc-line" d="M14 11 10.5 21M14 11l3.5 10"/><path class="sc-back" d="M8 21h12a6 4 0 0 1-12 0z"/></g>
<g class="sc-pan sc-pr"><path class="sc-line" d="M50 11l-3.5 10M50 11l3.5 10"/><path class="sc-back" d="M44 21h12a6 4 0 0 1-12 0z"/><path class="sc-role" d="M46.5 17.5h7l1 3.5h-9z"/></g></g>`,
  motion: `@keyframes sc-tip { 0%, 8% { transform: rotate(0deg); } 24% { transform: rotate(9deg); } 34% { transform: rotate(4deg); } 44%, 70% { transform: rotate(6deg); } 86%, 100% { transform: rotate(0deg); } }
@keyframes sc-level { 0%, 8% { transform: rotate(0deg); } 24% { transform: rotate(-9deg); } 34% { transform: rotate(-4deg); } 44%, 70% { transform: rotate(-6deg); } 86%, 100% { transform: rotate(0deg); } }
${B} .sc-beam { transform-origin: 32px 11px; ${run('sc-tip', 6, 0, 'ease-in-out')} }
${B} .sc-pl { transform-origin: 14px 11px; ${run('sc-level', 6, 0, 'ease-in-out')} }
${B} .sc-pr { transform-origin: 50px 11px; ${run('sc-level', 6, 0, 'ease-in-out')} }`,
};

/** Any other agent: a cog, turning while it works. */
export const DEFAULT_LOOK: Look = {
  accent: { light: '#66717c', dark: '#a7b1bc' },
  busy: 'Working',
  scene: `<g class="sc-cog sc-c1"><circle class="sc-teeth" cx="27" cy="20" r="10" stroke-dasharray="3.1 4.75"/><circle class="sc-soft" cx="27" cy="20" r="8"/><circle class="sc-back" cx="27" cy="20" r="2.6"/></g>
<g class="sc-cog sc-c2"><circle class="sc-teeth" cx="42.5" cy="28" r="6.2" stroke-dasharray="2.6 4.9"/><circle class="sc-soft" cx="42.5" cy="28" r="4.6"/><circle class="sc-back" cx="42.5" cy="28" r="1.6"/></g>`,
  motion: `@keyframes sc-turn { to { transform: rotate(360deg); } } @keyframes sc-turn-back { to { transform: rotate(-360deg); } }
${B} .sc-c1 { transform-origin: 27px 20px; ${run('sc-turn', 6)} } ${B} .sc-c2 { transform-origin: 42.5px 28px; ${run('sc-turn-back', 4)} }`,
};

/** Each kit agent's look, by its id. */
export const LOOK: Record<string, Look> = { porter, auditor, clerk, herald, 'developer-herald': developerHerald, warrener, aletaster, miller, pinder, steward, surveyor, lamplighter, smith, thatcher, reckoner, weigher, shepherd, reeve, chamberlain, heiward, toller, assayer };

/** This agent's look, or the default for one not listed. */
export const lookFor = (id: string): Look => (Object.hasOwn(LOOK, id) ? LOOK[id] : DEFAULT_LOOK);

/** The scene as page.ts puts it in the title bar: decorative, so hidden from screen readers. */
export const sceneSvg = (look: Look) =>
  `<svg class="scene" viewBox="0 0 64 40" width="64" height="40" aria-hidden="true" focusable="false">${look.scene}</svg>`;
