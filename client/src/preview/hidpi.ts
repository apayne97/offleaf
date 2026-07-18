/**
 * HiDPI canvas sizing for the PDF viewer.
 *
 * A canvas whose bitmap matches CSS pixels looks soft on Retina displays
 * (devicePixelRatio 2): the browser upscales a 1× bitmap. The standard fix —
 * the same one Mozilla's own PDF.js viewer applies — is to allocate the
 * bitmap at viewport × devicePixelRatio, pin the element's CSS size to the
 * viewport size, and hand PDF.js a matching scale transform.
 *
 * Kept as a pure function (no DOM) so the sizing rules are unit-testable.
 */

export interface HidpiRenderParams {
  /** Bitmap dimensions for canvas.width / canvas.height. */
  canvasWidth: number;
  canvasHeight: number;
  /** CSS dimensions for canvas.style.width / height (viewport size). */
  cssWidth: number;
  cssHeight: number;
  /** Transform for page.render(); undefined at 1× so PDF.js takes the fast path. */
  transform: [number, number, number, number, number, number] | undefined;
  /** The (capped) ratio actually applied. */
  ratio: number;
}

/** Cap the ratio: 2× already saturates a Retina panel; 3×+ displays would
 * otherwise cost 9× the pixels of 1× for no visible gain at reading sizes. */
export const MAX_RENDER_RATIO = 2;

export function renderParamsFor(
  viewportWidth: number,
  viewportHeight: number,
  devicePixelRatio: number,
): HidpiRenderParams {
  const raw = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const ratio = Math.min(raw, MAX_RENDER_RATIO);
  return {
    canvasWidth: Math.floor(viewportWidth * ratio),
    canvasHeight: Math.floor(viewportHeight * ratio),
    cssWidth: viewportWidth,
    cssHeight: viewportHeight,
    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    ratio,
  };
}
