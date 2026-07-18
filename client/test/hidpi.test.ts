/**
 * Unit tests for the HiDPI canvas sizing used by the PDF viewer
 * (client/src/preview/hidpi.ts). Run with `tsx test/hidpi.test.ts`.
 */
import { renderParamsFor, MAX_RENDER_RATIO } from "../src/preview/hidpi";

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

// A Retina MacBook (devicePixelRatio 2) — the case that motivated the fix.
const retina = renderParamsFor(765, 990, 2);
check("Retina: bitmap is 2x the viewport", retina.canvasWidth === 1530 && retina.canvasHeight === 1980);
check("Retina: CSS size stays at viewport size", retina.cssWidth === 765 && retina.cssHeight === 990);
check("Retina: render transform scales by 2", JSON.stringify(retina.transform) === "[2,0,0,2,0,0]");
check("Retina: applied ratio reported", retina.ratio === 2);

// A standard 1x display — must be byte-for-byte the old behaviour.
const std = renderParamsFor(765, 990, 1);
check("1x: bitmap equals viewport", std.canvasWidth === 765 && std.canvasHeight === 990);
check("1x: no transform (PDF.js fast path)", std.transform === undefined);

// Fractional ratios (external monitors, browser zoom) scale and floor cleanly.
const frac = renderParamsFor(765, 990, 1.5);
check("1.5x: bitmap floored to whole pixels", frac.canvasWidth === 1147 && frac.canvasHeight === 1485);
check("1.5x: transform matches ratio", frac.transform?.[0] === 1.5 && frac.transform?.[3] === 1.5);

// 3x+ phones/tablets are capped: 2x already saturates the panel at reading
// sizes, and an uncapped 3x costs 9x the pixels of 1x.
const capped = renderParamsFor(765, 990, 3);
check("3x: ratio capped at MAX_RENDER_RATIO", capped.ratio === MAX_RENDER_RATIO);
check("3x: bitmap sized at the cap, not the raw ratio", capped.canvasWidth === 765 * MAX_RENDER_RATIO);

// Garbage input degrades to 1x instead of producing 0-sized canvases.
check("0 ratio falls back to 1x", renderParamsFor(765, 990, 0).ratio === 1);
check("NaN ratio falls back to 1x", renderParamsFor(765, 990, NaN).ratio === 1);
check("negative ratio falls back to 1x", renderParamsFor(765, 990, -2).ratio === 1);

console.log(`\n${failures === 0 ? "ALL HIDPI TESTS PASSED" : failures + " HIDPI CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
