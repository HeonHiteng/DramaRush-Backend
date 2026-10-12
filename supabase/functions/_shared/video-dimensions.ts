/**
 * Picture size of an uploaded video, from a Cloudflare Stream video object or
 * webhook body (`input: { width, height }`). Null when missing or implausible
 * (Stream reports -1 while it hasn't probed the file yet).
 */
export interface VideoDimensions {
  width: number;
  height: number;
}

const MAX_SIDE = 16384;

function side(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_SIDE ? value : null;
}

export function videoDimensions(video: { input?: { width?: unknown; height?: unknown } | null } | null | undefined): VideoDimensions | null {
  const width = side(video?.input?.width);
  const height = side(video?.input?.height);
  return width !== null && height !== null ? { width, height } : null;
}
