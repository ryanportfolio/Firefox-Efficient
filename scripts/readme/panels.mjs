// SVG panels for README.md. Run through build.mjs; never edit the files in assets/readme/ by hand.
//
// CONSTRAINT CONTRACT (read before changing any art)
// - Conceit: every tab you are not looking at carries an idle clock, and all clocks run at the same speed
//   (they differ only in when you last looked at the tab). When a clock fills, the tab unloads, unless a rule
//   holds it: then the clock stays full, drawn grey, and the tab stays loaded while the rule applies. That is
//   what src/background.js does: idle time always counts; a keep rule only skips the unload. The tab on
//   screen has no clock (Firefox treats it as just accessed). A click on an unloaded tab loads it again, and
//   the tab you left starts its own clock.
// - What "unloaded" looks like: the tab's icon at half strength plus a neutral "unloaded" tag. Firefox shows
//   no change by default; with browser.tabs.fadeOutUnloadedTabs on, it fades the icon to 0.5, as drawn here.
//   The README prose says so. Never dim the title: Firefox does not.
// - Countable honesty: badges are exactly the keep rules in keepReason(), checked by facts.mjs. Minutes,
//   check period and footprint numbers come from the source, never typed here. Labels whose truth depends
//   on a number are chosen from that number.
// - No memory figures anywhere: the add-on cannot measure per-tab memory.
// - One accent (orange) and it means one thing: an idle clock that will unload its tab. Held clocks, tags
//   and everything else use ink, mute and rule from GitHub's own palette.
// - Works at 390 px: the narrow variant is a vertical list (like the add-on's own popup), not a scaled strip.
// - Works in light and dark: four files per panel, served through <picture>. <picture> picks by the browser's
//   prefers-color-scheme, but GitHub can be set to a different theme than the browser (GitHub dark, Windows
//   light), so the "wrong" variant can land on the page. Every panel therefore paints its own opaque card with
//   a border, so whichever variant shows is readable: a light card on a dark page, never dark text on dark.
//   GitHub's old #gh-dark-mode-only image fragments no longer hide anything (checked 2026-10-13).
// - No scripts, hover or external requests (GitHub blocks them): the story runs on a CSS loop. Under
//   prefers-reduced-motion all animation stops and the authored (static) state is the end of the story, so
//   the still frame is complete: one tab unloaded, one reloaded by a click, held clocks, a new clock started.
// - The loop seam is a short fade to nothing, never a slow dim: dimming means "unloaded" in this picture.
// - System fonts only; uncommon glyphs are drawn as paths.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, readFacts, EXEMPT_LABELS } from './facts.mjs';

const OUT = path.join(ROOT, 'assets', 'readme');

const THEMES = {
  light: { card: '#ffffff', ink: '#1f2328', mute: '#59636e', rule: '#d1d9e0', tabBg: '#f6f8fa', sel: '#ffffff', accent: '#bc4c00', tagBg: '#eaeef2', fav: ['#0969da', '#1a7f37', '#8250df', '#bf3989', '#9a6700', '#cf222e', '#57606a'] },
  dark: { card: '#0d1117', ink: '#f0f6fc', mute: '#9198a1', rule: '#3d444d', tabBg: '#151b23', sel: '#262c36', accent: '#f0883e', tagBg: '#262c36', fav: ['#4493f8', '#3fb950', '#ab7df8', '#db61a2', '#d29922', '#f85149', '#9198a1'] },
};
const MONO = "ui-monospace,'SF Mono','Cascadia Mono',Menlo,Consolas,'Liberation Mono',monospace";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif";
const LOOP = 16; // seconds
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f = (n) => Number(n.toFixed(2));
const R = 7; // clock radius
const C = 2 * Math.PI * R;

function svg(c, W, H, label, css, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">
<style>${css}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>
<rect class="card" x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="10" fill="${c.card}" stroke="${c.rule}"/>
${body}
</svg>
`;
}

// ---- glyphs (drawn, not typed) --------------------------------------------------------------------------
const GLYPH = {
  active: (c) => `<rect x="-6" y="-5" width="12" height="8.5" rx="1.2" fill="none" stroke="${c}" stroke-width="1.6"/><path d="M-3 6.2h6M0 3.5v2.7" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`,
  pinned: (c) => `<path d="M-3.2 -6h6.4l-1.2 4.2 2.6 2.4h-9.2l2.6-2.4z" fill="${c}"/><path d="M0 0.6v6" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`,
  audible: (c) => `<path d="M-6.5 -2.4h2.6l3.6-3.1v11l-3.6-3.1h-2.6z" fill="${c}"/><path d="M2.4 -2.6a3.6 3.6 0 0 1 0 5.2M4.6 -4.8a6.6 6.6 0 0 1 0 9.6" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round"/>`,
  sharing: (c) => `<rect x="-6.5" y="-4" width="9" height="8" rx="1.6" fill="${c}"/><path d="M3.2 -1.2l3.6-2.4v7.2l-3.6-2.4z" fill="${c}"/>`,
  'never-unload': (c, cut) => `<path d="M0 -6.5l5.6 2.1v3.6c0 3.4-2.4 5.9-5.6 7.3-3.2-1.4-5.6-3.9-5.6-7.3v-3.6z" fill="${c}"/><path d="M-2.4 0.2l1.7 1.8 3.2-3.4" fill="none" stroke="${cut}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
};
const badge = (kind, c, x, y) => `<g transform="translate(${f(x)} ${f(y)})">${GLYPH[kind](c.mute, c.sel)}</g>`;

// ---- the story ------------------------------------------------------------------------------------------
// p0 = how full a tab's clock is at the start of the loop. Every clock fills at RATE per loop.
const RATE = 1 / 0.6; // empty to full in 60% of the loop
const CLICK = 70; // % of loop when the cursor clicks the unloaded tab
const NEW_CLOCK = CLICK + 1; // the tab you left starts counting the moment you leave it (lastAccessed)...
const NEW_P0 = 0; // ...from empty
const REST = 88; // authored still frame (what reduced-motion readers see)
const TABS = [
  { id: 'pin', kind: 'pinned', title: 'Mail', p0: 0.85, fav: 6 },
  { id: 'notes', kind: 'idle', title: 'Changelog', p0: 0.5, fav: 0 },
  { id: 'lecture', kind: 'audible', title: 'Lecture', p0: 0.3, fav: 1 },
  { id: 'call', kind: 'sharing', title: 'Call', p0: 0.6, fav: 2 },
  { id: 'admin', kind: 'never-unload', title: 'Admin', p0: 0.95, fav: 3 },
  { id: 'recipe', kind: 'idle', title: 'Recipe', p0: 0.12, fav: 4 },
  { id: 'search', kind: 'active', title: 'Search', fav: 5 },
];
const CLICKED = 'notes';
const LEFT = 'search';
const fullAt = (p0) => f(Math.min(100, ((1 - p0) / RATE) * 100));
const progress = (p0, pct) => Math.min(1, p0 + (RATE * pct) / 100);

function keyframes(name, stops) {
  return `@keyframes ${name}{${stops.map(([p, d]) => `${p}%{${d}}`).join('')}}`;
}

function storyCss(c, cursor) {
  const css = [];
  const anim = (name, stops) => css.push(keyframes(name, stops), `.${name}{animation:${name} ${LOOP}s linear infinite}`);
  anim('scene', [[0, 'opacity:0'], [1.5, 'opacity:1'], [97.5, 'opacity:1'], [99.5, 'opacity:0'], [100, 'opacity:0']]);

  for (const t of TABS.filter((t) => t.kind !== 'active')) {
    const full = fullAt(t.p0);
    anim(`ring-${t.id}`, [[0, `stroke-dashoffset:${f(C * (1 - t.p0))}`], [full, 'stroke-dashoffset:0'], [100, 'stroke-dashoffset:0']]);
    // a protected tab's clock runs like any other (orange) and turns grey once it fills and a rule holds it
    if (t.kind !== 'idle') anim(`hold-${t.id}`, [[0, `stroke:${c.accent}`], [full, `stroke:${c.accent}`], [f(Math.min(100, full + 0.5)), `stroke:${c.mute}`], [100, `stroke:${c.mute}`]]);
  }
  for (const t of TABS.filter((t) => t.kind === 'idle')) {
    const full = fullAt(t.p0);
    const back = t.id === CLICKED;
    anim(`clock-${t.id}`, [[0, 'opacity:1'], [full, 'opacity:1'], [f(full + 1), 'opacity:0'], [100, 'opacity:0']]);
    anim(`fav-${t.id}`, back
      ? [[0, 'opacity:1'], [full, 'opacity:1'], [f(full + 2), 'opacity:.5'], [CLICK, 'opacity:.5'], [CLICK + 3, 'opacity:1'], [100, 'opacity:1']]
      : [[0, 'opacity:1'], [full, 'opacity:1'], [f(full + 2), 'opacity:.5'], [100, 'opacity:.5']]);
    anim(`tag-${t.id}`, back
      ? [[0, 'opacity:0'], [f(full + 1), 'opacity:0'], [f(full + 3), 'opacity:1'], [CLICK, 'opacity:1'], [CLICK + 2, 'opacity:0'], [100, 'opacity:0']]
      : [[0, 'opacity:0'], [f(full + 1), 'opacity:0'], [f(full + 3), 'opacity:1'], [100, 'opacity:1']]);
  }
  anim(`sel-${LEFT}`, [[0, 'opacity:1'], [CLICK, 'opacity:1'], [CLICK + 1, 'opacity:0'], [100, 'opacity:0']]);
  anim(`sel-${CLICKED}`, [[0, 'opacity:0'], [CLICK, 'opacity:0'], [CLICK + 1, 'opacity:1'], [100, 'opacity:1']]);
  anim(`ring-${LEFT}`, [[0, `stroke-dashoffset:${f(C * (1 - NEW_P0))}`], [NEW_CLOCK, `stroke-dashoffset:${f(C * (1 - NEW_P0))}`],
    [100, `stroke-dashoffset:${f(C * (1 - progress(NEW_P0, 100 - NEW_CLOCK)))}`]]);
  anim(`clock-${LEFT}`, [[0, 'opacity:0'], [NEW_CLOCK - 1, 'opacity:0'], [NEW_CLOCK, 'opacity:1'], [100, 'opacity:1']]);
  const from = `transform:translate(${cursor.dx}px,${cursor.dy}px)`;
  anim('cursor', [[0, `opacity:0;${from}`], [56, `opacity:0;${from}`], [58, `opacity:1;${from}`], [CLICK - 2, 'opacity:1;transform:translate(0px,0px)'],
    [90, 'opacity:1;transform:translate(0px,0px)'], [92, 'opacity:0;transform:translate(0px,0px)'], [100, 'opacity:0;transform:translate(0px,0px)']]);
  anim('ping', [[0, 'opacity:0;transform:scale(.15)'], [CLICK - 1, 'opacity:0;transform:scale(.15)'], [CLICK, 'opacity:.9;transform:scale(.25)'], [CLICK + 4, 'opacity:0;transform:scale(1)'], [100, 'opacity:0;transform:scale(1)']]);
  css.push('.ping{transform-box:fill-box;transform-origin:center}');
  return css.join('\n');
}

// Each animated property's value at REST, so the static frame is the same frame the loop passes through.
function restState(t) {
  if (t.id === LEFT) return { clock: REST >= NEW_CLOCK ? 1 : 0, dash: f(C * (1 - progress(NEW_P0, Math.max(0, REST - NEW_CLOCK)))), fav: 1, tag: 0, sel: REST > CLICK ? 0 : 1 };
  const dash = f(C * (1 - progress(t.p0, REST)));
  if (t.kind !== 'idle') return { clock: 1, dash, fav: 1, tag: 0, sel: 0 };
  const full = fullAt(t.p0);
  const unloaded = REST > full + 2 && !(t.id === CLICKED && REST >= CLICK + 3);
  return { clock: REST > full + 1 ? 0 : 1, dash, fav: unloaded ? 0.5 : 1, tag: unloaded ? 1 : 0, sel: t.id === CLICKED && REST > CLICK ? 1 : 0 };
}

function clock(t, c, x, y, held) {
  const s = restState(t);
  const cls = t.kind === 'idle' || t.id === LEFT ? ` class="clock-${t.id}" opacity="${s.clock}"` : '';
  const ring = `<circle class="ring-${t.id}" r="${R}" fill="none" stroke-width="2.4" stroke-dasharray="${f(C)}" style="stroke-dashoffset:${s.dash}" transform="rotate(-90)"/>`;
  // held clocks take their colour from a wrapper that turns orange to grey when the clock fills
  const colored = held
    ? `<g class="hold-${t.id}" style="stroke:${s.dash === 0 ? c.mute : c.accent}">${ring}</g>`
    : `<g style="stroke:${c.accent}">${ring}</g>`;
  return `<g${cls} transform="translate(${f(x)} ${f(y)})"><circle r="${R}" fill="none" stroke="${c.rule}" stroke-width="2.4"/>${colored}</g>`;
}

// ---- hero -----------------------------------------------------------------------------------------------
// One description of the hero, used for the SVG's aria-label and the README's alt text.
export function heroDescription(facts) {
  const held = facts.exemptions.filter((k) => k !== 'active').map((k) => EXEMPT_LABELS[k]);
  const every = facts.checkMinutes === 1 ? 'every minute' : `every ${facts.checkMinutes} minutes`;
  return `A Firefox tab strip. Each tab you are not looking at has an idle clock; when it fills, the tab unloads and its icon fades. A tab that is ${held.slice(0, -1).join(', ')} or ${held.at(-1)} keeps running its clock, but when the clock fills it turns grey and the tab stays loaded. A click on an unloaded tab loads it again, and the tab you left starts a new clock. Default limit ${facts.idleMinutes} minutes, checked ${every}.`;
}

function hero(c, narrow, facts) {
  const W = narrow ? 390 : 880;
  const parts = [];
  const geom = [];
  if (!narrow) {
    const top = 22, h = 40, x0 = 16, pinW = 64, gap = 4;
    const rest = (W - 2 * x0 - pinW - gap * (TABS.length - 1)) / (TABS.length - 1);
    let x = x0;
    for (const t of TABS) { const w = t.id === 'pin' ? pinW : rest; geom.push({ t, x, y: top, w, h }); x += w + gap; }
  } else {
    TABS.forEach((t, i) => geom.push({ t, x: 12, y: 16 + i * 44, w: W - 24, h: 38 }));
  }

  for (const { t, x, y, w, h } of geom) {
    const s = restState(t);
    const cy = y + h / 2;
    const iconOnly = !narrow && t.id === 'pin';
    parts.push(`<rect x="${f(x)}" y="${y}" width="${f(w)}" height="${h}" rx="7" fill="${c.tabBg}" stroke="${c.rule}"/>`);
    const selRect = `<rect x="${f(x)}" y="${y}" width="${f(w)}" height="${h}" rx="7" fill="${c.sel}" stroke="${c.ink}" stroke-opacity=".55" stroke-width="1.2"/><rect x="${f(x + 8)}" y="${y}" width="${f(w - 16)}" height="2.5" rx="1.2" fill="${c.ink}"/>`;
    if (t.id === LEFT || t.id === CLICKED) parts.push(`<g class="sel-${t.id}" opacity="${s.sel}">${selRect}</g>`);
    const fav = `<rect x="${f(x + 11)}" y="${cy - 7}" width="14" height="14" rx="3.5" fill="${c.fav[t.fav]}"/>`;
    parts.push(t.kind === 'idle' ? `<g class="fav-${t.id}" opacity="${s.fav}">${fav}</g>` : fav);
    const clockX = x + w - 16;
    const badgeX = clockX - 20;
    if (!iconOnly) {
      const limit = (t.kind === 'idle' || t.kind === 'active' ? clockX - 10 : badgeX - 8) - (narrow && t.kind === 'idle' ? 70 : 0);
      if (x + 32 + t.title.length * 6.9 > limit) throw new Error(`tab title overflows: ${t.title}`);
      parts.push(`<text x="${f(x + 32)}" y="${cy + 4.5}" font-family="${SANS}" font-size="13" fill="${c.ink}">${esc(t.title)}</text>`);
    }
    if (t.kind === 'active') {
      // on screen: the badge; after the click it becomes the tab you left, with a new clock
      parts.push(`<g class="sel-${t.id}" opacity="${s.sel}">${badge('active', c, clockX, cy)}</g>`, clock(t, c, clockX, cy, false));
    } else if (t.kind === 'idle') {
      parts.push(clock(t, c, clockX, cy, false));
      if (t.id === CLICKED) parts.push(`<g class="sel-${t.id}" opacity="${s.sel}">${badge('active', c, clockX, cy)}</g>`);
      const tagW = 64;
      const tx = narrow ? clockX - 12 - tagW : x + 8;
      const ty = narrow ? cy - 9 : y + h + 5;
      parts.push(`<g class="tag-${t.id}" opacity="${s.tag}"><rect x="${f(tx)}" y="${f(ty)}" width="${tagW}" height="18" rx="9" fill="${c.tagBg}"/><text x="${f(tx + tagW / 2)}" y="${f(ty + 12.5)}" text-anchor="middle" font-family="${MONO}" font-size="10.5" fill="${c.mute}">unloaded</text></g>`);
    } else {
      parts.push(badge(t.kind, c, iconOnly ? x + 36 : badgeX, cy), clock(t, c, clockX, cy, true));
    }
  }

  const target = geom.find((g) => g.t.id === CLICKED);
  const tx = f(target.x + target.w * (narrow ? 0.4 : 0.5)), ty = f(target.y + target.h * 0.62);
  const cx0 = narrow ? 150 : 420, cy0 = narrow ? 150 : 70;
  parts.push(`<circle class="ping" cx="${tx}" cy="${ty}" r="14" fill="none" stroke="${c.ink}" stroke-width="2" opacity="0"/>`);
  parts.push(`<g class="cursor" opacity="0"><path transform="translate(${tx} ${ty})" d="M0 0v15.5l3.9-3.7 2.6 6 2.5-1.1-2.6-5.9 5.4-.2z" fill="${c.ink}" stroke="${c.sel}" stroke-width="1.2" stroke-linejoin="round"/></g>`);

  // legend: the two kinds of clock, then exactly the keep rules from keepReason(), in code order
  const L = [];
  const fs_ = narrow ? 13.5 : 12.5;
  const lx = narrow ? 12 : 16;
  let ly = narrow ? 16 + TABS.length * 44 + 16 : 22 + 40 + 44;
  const keyClock = (x, y, color, p) => `<g transform="translate(${x} ${y})"><circle r="6" fill="none" stroke="${c.rule}" stroke-width="2.2"/><circle r="6" fill="none" stroke="${color}" stroke-width="2.2" stroke-dasharray="${f(2 * Math.PI * 6)}" stroke-dashoffset="${f(2 * Math.PI * 6 * (1 - p))}" transform="rotate(-90)"/></g>`;
  const keyA = `idle clock: the tab unloads when it fills`;
  const keyB = `held: a rule below keeps the tab loaded`;
  if (!narrow) {
    L.push(`${keyClock(lx + 7, ly - 4, c.accent, 0.65)}<text x="${lx + 20}" y="${ly}" font-family="${SANS}" font-size="${fs_}" fill="${c.ink}">${keyA}</text>`);
    const bx = lx + 20 + keyA.length * 6.4 + 30;
    L.push(`${keyClock(bx + 7, ly - 4, c.mute, 1)}<text x="${f(bx + 20)}" y="${ly}" font-family="${SANS}" font-size="${fs_}" fill="${c.ink}">${keyB}</text>`);
    ly += 30;
  } else {
    L.push(`${keyClock(lx + 7, ly - 4, c.accent, 0.65)}<text x="${lx + 22}" y="${ly}" font-family="${SANS}" font-size="${fs_}" fill="${c.ink}">${keyA}</text>`);
    L.push(`${keyClock(lx + 7, ly + 20, c.mute, 1)}<text x="${lx + 22}" y="${ly + 24}" font-family="${SANS}" font-size="${fs_}" fill="${c.ink}">${keyB}</text>`);
    ly += 56;
  }
  L.push(`<text x="${lx}" y="${ly}" font-family="${SANS}" font-size="${fs_}" font-weight="600" fill="${c.mute}">Kept loaded while the tab is</text>`);
  const items = facts.exemptions.map((k) => ({ k, label: EXEMPT_LABELS[k] }));
  if (!narrow) {
    let x = lx;
    const y = ly + 24;
    for (const it of items) {
      L.push(`<g data-exempt="${it.k}">${badge(it.k, c, x + 8, y - 4)}<text x="${f(x + 22)}" y="${y}" font-family="${SANS}" font-size="${fs_}" fill="${c.ink}">${esc(it.label)}</text></g>`);
      x += 22 + it.label.length * 6.4 + 20;
    }
    if (x > W) throw new Error(`hero legend overflows: ${f(x)} > ${W}`);
    ly = y + 32;
  } else {
    items.forEach((it, i) => {
      const y = ly + 26 + i * 24;
      L.push(`<g data-exempt="${it.k}">${badge(it.k, c, lx + 8, y - 4)}<text x="${lx + 24}" y="${y}" font-family="${SANS}" font-size="${fs_}" fill="${c.ink}">${esc(it.label)}</text></g>`);
    });
    ly = ly + 26 + items.length * 24 + 10;
  }
  const every = facts.checkMinutes === 1 ? 'every minute' : `every ${facts.checkMinutes} minutes`;
  const caps = narrow
    ? [`Default limit ${facts.idleMinutes} min, checked ${every}.`, 'Clock time is sped up in this picture.']
    : [`Default limit ${facts.idleMinutes} min, checked ${every}. Clock time is sped up in this picture.`];
  caps.forEach((line, i) => L.push(`<text x="${lx}" y="${ly + i * 20}" font-family="${SANS}" font-size="${fs_}" fill="${c.mute}">${esc(line)}</text>`));
  const maxChars = Math.max(...caps.map((l) => l.length), keyA.length + (narrow ? 4 : keyB.length + 8));
  if (maxChars * 0.505 * fs_ > W - 2 * lx) throw new Error('hero text overflows');

  const H = ly + (caps.length - 1) * 20 + 14;
  const label = `Animated picture. ${heroDescription(facts)}`;
  const css = storyCss(c, { dx: f(cx0 - tx), dy: f(cy0 - ty) });
  return svg(c, W, H, label, css, `<g class="scene">\n${parts.join('\n')}\n</g>\n${L.join('\n')}`);
}

// ---- footprint ------------------------------------------------------------------------------------------
export function footprintCells(facts) {
  const reads = facts.contentScripts + facts.hostPermissions;
  const deps = facts.runtimeDeps + facts.imports;
  return [
    { n: String(facts.permissions.length), unit: 'permissions', note: facts.permissions.join(' · ') },
    { n: String(reads), unit: 'page contents read', note: reads === 0 ? (facts.permissions.includes('tabs') ? 'sees tab titles, addresses' : 'no site access') : 'has site access' },
    { n: String(facts.networkCalls), unit: 'requests of its own', note: facts.iconLoads ? 'list shows tab icons by URL' : facts.networkCalls === 0 ? 'nothing sent anywhere' : 'see src/' },
    { n: String(facts.dataCollected.length), unit: 'data types collected', note: 'as declared to Mozilla' },
    { n: String(facts.sourceKB), unit: `KB in ${facts.sourceFiles} source files`, note: deps === 0 ? 'no runtime dependencies' : `${deps} runtime dependencies` },
  ];
}

function footprint(c, narrow, facts) {
  const W = narrow ? 390 : 880;
  const cells = footprintCells(facts);
  const parts = [];
  if (!narrow) {
    const cw = (W - 24) / cells.length;
    cells.forEach((cell, i) => {
      const x = 12 + i * cw + 8;
      if (cell.note.length * 0.505 * 11.5 > cw - 12 || cell.unit.length * 0.53 * 13 > cw - 12) throw new Error(`footprint text overflows: ${cell.unit} / ${cell.note}`);
      parts.push(`<g data-fact="${esc(cell.unit)}"><text x="${f(x)}" y="42" font-family="${MONO}" font-size="28" font-weight="600" fill="${c.ink}">${esc(cell.n)}</text><text x="${f(x)}" y="62" font-family="${SANS}" font-size="13" font-weight="600" fill="${c.ink}">${esc(cell.unit)}</text><text x="${f(x)}" y="78" font-family="${SANS}" font-size="11.5" fill="${c.mute}">${esc(cell.note)}</text></g>`);
      if (i > 0) parts.push(`<line x1="${f(12 + i * cw)}" y1="20" x2="${f(12 + i * cw)}" y2="80" stroke="${c.rule}"/>`);
    });
    return { svg: svg(c, W, 94, footLabel(cells), '', parts.join('\n')), cells };
  }
  // narrow: one row per fact, number on the left, words on the right
  cells.forEach((cell, i) => {
    const y = 14 + i * 46;
    if (cell.note.length * 0.505 * 12.5 > W - 96) throw new Error(`footprint note overflows: ${cell.note}`);
    parts.push(`<g data-fact="${esc(cell.unit)}"><text x="74" y="${y + 26}" text-anchor="end" font-family="${MONO}" font-size="26" font-weight="600" fill="${c.ink}">${esc(cell.n)}</text><text x="88" y="${y + 14}" font-family="${SANS}" font-size="14" font-weight="600" fill="${c.ink}">${esc(cell.unit)}</text><text x="88" y="${y + 31}" font-family="${SANS}" font-size="12.5" fill="${c.mute}">${esc(cell.note)}</text></g>`);
    if (i > 0) parts.push(`<line x1="12" y1="${y - 6}" x2="${W - 12}" y2="${y - 6}" stroke="${c.rule}"/>`);
  });
  return { svg: svg(c, W, 14 + cells.length * 46, footLabel(cells), '', parts.join('\n')), cells };
}
const footLabel = (cells) => `What the add-on can touch: ${cells.map((cl) => `${cl.n} ${cl.unit} (${cl.note})`).join('; ')}.`;

// ---- write + verify -------------------------------------------------------------------------------------
export function buildPanels({ write = true } = {}) {
  const facts = readFacts();
  const files = {}; // file name in assets/readme -> SVG text
  for (const t of ['light', 'dark']) {
    for (const narrow of [false, true]) {
      const sfx = `${narrow ? 'narrow-' : ''}${t}`;
      files[`hero-${sfx}.svg`] = hero(THEMES[t], narrow, facts).replace(/\r\n/g, '\n');
      files[`footprint-${sfx}.svg`] = footprint(THEMES[t], narrow, facts).svg.replace(/\r\n/g, '\n');
    }
  }
  if (write) {
    fs.mkdirSync(OUT, { recursive: true });
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), text);
  }

  // verify: every panel shows the facts it is responsible for, recomputed above
  let bad = 0;
  const need = {
    hero: [`Default limit ${facts.idleMinutes} min`, ...facts.exemptions.map((k) => `data-exempt="${k}"`)],
    footprint: footprintCells(facts).flatMap((cl) => [`>${esc(cl.n)}<`, `>${esc(cl.unit)}<`]),
  };
  for (const [name, text] of Object.entries(files)) {
    const kind = name.startsWith('hero') ? 'hero' : 'footprint';
    for (const s of need[kind]) {
      if (!text.includes(s)) { console.error(`FAIL ${name}: missing ${s}`); bad++; }
    }
    if (kind === 'hero') {
      const shown = [...text.matchAll(/data-exempt="([a-z-]+)"/g)].map((m) => m[1]);
      if (shown.length !== facts.exemptions.length) { console.error(`FAIL ${name}: ${shown.length} keep rules drawn, code has ${facts.exemptions.length}`); bad++; }
      // the accent belongs to clocks only: never on text, tags, badges or tab shapes
      const accent = THEMES[name.includes('dark') ? 'dark' : 'light'].accent;
      if (new RegExp(`<(text|rect|path)[^>]*fill="${accent}"`).test(text)) { console.error(`FAIL ${name}: accent used outside a clock`); bad++; }
    }
    if (/\b\d+(\.\d+)?\s?(MB|GB)\b|memory saved/i.test(text)) { console.error(`FAIL ${name}: memory figure in art`); bad++; }
    if (/<script|href="http|xlink:href/.test(text)) { console.error(`FAIL ${name}: script or external reference`); bad++; }
    // the opaque card keeps a mismatched variant readable (GitHub theme differs from the browser's)
    if (!/<\/style>\s*<rect class="card"[^>]*fill="#[0-9a-f]{6}"/.test(text)) { console.error(`FAIL ${name}: no opaque card behind the art`); bad++; }
  }
  if (bad) throw new Error(`panels: ${bad} check(s) failed`);
  return { facts, files };
}

// --check: build in memory and compare with the committed files (line endings normalized).
export function checkPanels() {
  const { files } = buildPanels({ write: false });
  let bad = 0;
  const onDisk = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((n) => n.endsWith('.svg')) : [];
  for (const [name, text] of Object.entries(files)) {
    const p = path.join(OUT, name);
    if (!fs.existsSync(p)) { console.error(`FAIL assets/readme/${name} missing; run node scripts/readme/build.mjs`); bad++; continue; }
    if (fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') !== text) { console.error(`FAIL assets/readme/${name} is stale; run node scripts/readme/build.mjs`); bad++; }
  }
  for (const name of onDisk) if (!(name in files)) { console.error(`FAIL assets/readme/${name} is not produced by the generator`); bad++; }
  return bad;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) process.exitCode = checkPanels() ? 1 : 0;
  else console.error(`panels: wrote ${Object.keys(buildPanels().files).length} files to assets/readme/`);
}
