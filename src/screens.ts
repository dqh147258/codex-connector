/** One-shot screen capture contract. Image bytes are memory-only, never state/results. */
export const SCREEN_MAX_DISPLAYS = 8;
export const SCREEN_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const SCREEN_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const SCREEN_ERRORS = ['SCREEN_DISABLED','SCREEN_DESKTOP_REQUIRED','SCREEN_PERMISSION_DENIED','SCREEN_LOCKED','SCREEN_UNAVAILABLE','SCREEN_SELECTION_UNAVAILABLE','SCREEN_NOT_FOUND','SCREEN_LAYOUT_CHANGED','SCREEN_LIMIT_EXCEEDED','SCREEN_BUSY','SCREEN_TIMEOUT','SCREEN_RESTART_REQUIRED','SCREEN_REQUEST_EXPIRED','SCREEN_CANCELLED','SCREEN_UPLOAD_UNAVAILABLE','SCREEN_UPLOAD_REJECTED','SCREEN_UPLOAD_UNCERTAIN','SCREEN_SLACK_THREAD_REQUIRED'] as const;
export class ScreenError extends Error { constructor(readonly code: typeof SCREEN_ERRORS[number]) { super(code); } }
export interface ScreenDisplay { id: string; width: number; height: number; scaleFactor: number; primary: boolean }
export interface ScreenListing { displays: ScreenDisplay[]; platform: string; selectionSupported: boolean; permission: string }
export interface ScreenImage { displayId: string; width: number; height: number; jpeg: Buffer }
export interface ScreenPort {
  list(): Promise<ScreenListing>;
  capture(displayId: string): Promise<ScreenImage[]>;
}
export function validDisplayId(id: unknown): id is string { return typeof id === 'string' && /^(?:all|-?\d{1,16})$/.test(id); }
export function validateScreenImages(value: unknown, selection: string): ScreenImage[] {
  if (!Array.isArray(value) || !value.length || value.length > SCREEN_MAX_DISPLAYS) throw new ScreenError('SCREEN_LIMIT_EXCEEDED');
  const seen = new Set<string>(); let bytes = 0;
  for (const image of value) {
    if (!image || !validDisplayId(image.displayId) || image.displayId === 'all' || seen.has(image.displayId) || (selection !== 'all' && image.displayId !== selection) ||
      !Number.isInteger(image.width) || image.width < 1 || image.width > 2560 || !Number.isInteger(image.height) || image.height < 1 || image.height > 2560 ||
      !Buffer.isBuffer(image.jpeg) || image.jpeg.length < 4 || image.jpeg.length > SCREEN_MAX_IMAGE_BYTES || image.jpeg[0] !== 0xff || image.jpeg[1] !== 0xd8 || image.jpeg.at(-2) !== 0xff || image.jpeg.at(-1) !== 0xd9) throw new ScreenError('SCREEN_UNAVAILABLE');
    seen.add(image.displayId); bytes += image.jpeg.length;
  }
  if (bytes > SCREEN_MAX_TOTAL_BYTES || (selection !== 'all' && value.length !== 1)) throw new ScreenError('SCREEN_LIMIT_EXCEEDED');
  return value;
}
