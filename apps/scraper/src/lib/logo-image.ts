import type sharpModule from 'sharp';

/** Logo edge in pixels: sharp at the 24 to 56 px the site shows, a few KB each. */
export const LOGO_SIZE = 64;
/** A logo is a small picture: anything larger is refused before it is decoded. */
const MAX_INPUT_PIXELS = 2048 * 2048;

// A type only: the library itself is imported on first use (loadSharp).
type Sharp = typeof sharpModule;
let loading: Promise<Sharp | null> | null = null;

/**
 * The image library, loaded on first use: if its native part cannot load on a server, the team
 * logos stop (the task logs it) and nothing else in the scraper does.
 */
function loadSharp(): Promise<Sharp | null> {
  if (loading === null) {
    loading = import('sharp').then(
      (module) => module.default,
      () => null,
    );
  }
  return loading;
}

/** Whether logos can be made here (the image library loads). */
export async function logoImagesAvailable(): Promise<boolean> {
  return (await loadSharp()) !== null;
}

/**
 * A downloaded team logo as a small PNG: fitted in a 64 px square with a transparent background,
 * palette-quantised. Null when the bytes are not an image the library can read (or it is missing).
 */
export async function shrinkLogo(bytes: Uint8Array): Promise<Buffer | null> {
  const sharp = await loadSharp();
  if (sharp === null) return null;
  try {
    return await sharp(Buffer.from(bytes), { limitInputPixels: MAX_INPUT_PIXELS })
      .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ palette: true, quality: 90, compressionLevel: 9 })
      .toBuffer();
  } catch {
    return null;
  }
}
