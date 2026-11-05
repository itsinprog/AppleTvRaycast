// Generates the remote artwork in assets/: one SVG per "pressed" state so the Remote view can
// light up the button you just used. Run: npx tsx scripts/gen-remote-svgs.ts
import fs from "node:fs";
import path from "node:path";

const BLUE = "#0A84FF";
const BODY = "#1c1c1e";
const PAD = "#2a2a2d";
const KEY = "#38383b";
const GLYPH = "#d1d1d6";
const EDGE = "#3a3a3c";

type State = "idle" | "up" | "down" | "left" | "right" | "select" | "menu" | "home" | "play_pause" | "volume_up" | "volume_down";
const STATES: State[] = ["idle", "up", "down", "left", "right", "select", "menu", "home", "play_pause", "volume_up", "volume_down"];

const CX = 120;
const CY = 140;

function sector(r1: number, r2: number, a1: number, a2: number): string {
  const p = (r: number, a: number) => `${(CX + r * Math.cos((a * Math.PI) / 180)).toFixed(2)} ${(CY + r * Math.sin((a * Math.PI) / 180)).toFixed(2)}`;
  return `M ${p(r2, a1)} A ${r2} ${r2} 0 0 1 ${p(r2, a2)} L ${p(r1, a2)} A ${r1} ${r1} 0 0 0 ${p(r1, a1)} Z`;
}

function render(active: State): string {
  const on = (s: State) => active === s;
  const g = (s: State) => (on(s) ? "#fff" : GLYPH);
  const wedge = (s: State, a1: number, a2: number) => (on(s) ? `<path d="${sector(46, 96, a1, a2)}" fill="${BLUE}"/>` : "");
  const stroke = (s: State, w = 4) => `stroke="${g(s)}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 460" width="240" height="460">
  <rect x="10" y="6" width="220" height="448" rx="56" fill="${BODY}" stroke="${EDGE}" stroke-width="2"/>
  <circle cx="${CX}" cy="${CY}" r="96" fill="${PAD}" stroke="${EDGE}" stroke-width="1.5"/>
  ${wedge("up", -135, -45)}${wedge("right", -45, 45)}${wedge("down", 45, 135)}${wedge("left", 135, 225)}
  <circle cx="${CX}" cy="${CY}" r="46" fill="${on("select") ? BLUE : KEY}" stroke="${BODY}" stroke-width="3"/>
  <path d="M 120 88 L 108 106 L 132 106 Z" fill="${g("up")}"/>
  <path d="M 120 192 L 108 174 L 132 174 Z" fill="${g("down")}"/>
  <path d="M 68 140 L 86 128 L 86 152 Z" fill="${g("left")}"/>
  <path d="M 172 140 L 154 128 L 154 152 Z" fill="${g("right")}"/>

  <circle cx="66" cy="292" r="30" fill="${on("menu") ? BLUE : PAD}" stroke="${EDGE}" stroke-width="1.5"/>
  <path d="M 72 280 L 60 292 L 72 304" ${stroke("menu")}/>

  <circle cx="174" cy="292" r="30" fill="${on("home") ? BLUE : PAD}" stroke="${EDGE}" stroke-width="1.5"/>
  <rect x="161" y="281" width="26" height="18" rx="4" ${stroke("home", 3)}/>
  <path d="M 168 307 L 180 307" ${stroke("home", 3)}/>

  <circle cx="66" cy="386" r="30" fill="${on("play_pause") ? BLUE : PAD}" stroke="${EDGE}" stroke-width="1.5"/>
  <path d="M 53 374 L 53 398 L 68 386 Z" fill="${g("play_pause")}"/>
  <rect x="74" y="374" width="4.5" height="24" rx="1.5" fill="${g("play_pause")}"/>
  <rect x="82" y="374" width="4.5" height="24" rx="1.5" fill="${g("play_pause")}"/>

  <defs><clipPath id="rocker"><rect x="144" y="338" width="60" height="96" rx="30"/></clipPath></defs>
  <rect x="144" y="338" width="60" height="96" rx="30" fill="${PAD}" stroke="${EDGE}" stroke-width="1.5"/>
  <g clip-path="url(#rocker)">
    ${on("volume_up") ? `<rect x="144" y="338" width="60" height="48" fill="${BLUE}"/>` : ""}
    ${on("volume_down") ? `<rect x="144" y="386" width="60" height="48" fill="${BLUE}"/>` : ""}
  </g>
  <path d="M 167 362 L 181 362 M 174 355 L 174 369" ${stroke("volume_up", 3.5)}/>
  <path d="M 167 410 L 181 410" ${stroke("volume_down", 3.5)}/>
</svg>
`;
}

const dir = path.join(__dirname, "..", "assets");
fs.mkdirSync(dir, { recursive: true });
for (const s of STATES) fs.writeFileSync(path.join(dir, `remote-${s}.svg`), render(s));
console.log(`Wrote ${STATES.length} files to ${dir}`);
