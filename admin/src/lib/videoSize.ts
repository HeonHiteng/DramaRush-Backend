/**
 * Picture orientation. The app is vertical: landscape videos are shown with
 * black bars (and a "Watch in landscape" button), so the console flags them.
 * Same threshold as the app's player (LANDSCAPE_MIN_RATIO).
 */
export type Orientation = 'landscape' | 'portrait' | 'square';

const MIN_RATIO = 1.05;

export function orientationOf(width: number | null | undefined, height: number | null | undefined): Orientation | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  if (width > height * MIN_RATIO) return 'landscape';
  if (height > width * MIN_RATIO) return 'portrait';
  return 'square';
}

/**
 * Reads a local video file's picture size in the browser (metadata only, the
 * file isn't uploaded or fully decoded). Null if the browser can't tell
 * within the timeout (e.g. a codec it can't play).
 */
export function probeVideoSize(file: File, timeoutMs = 8000): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;
    const finish = (size: { width: number; height: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(size);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () =>
      finish(video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : null);
    video.onerror = () => finish(null);
    video.src = url;
  });
}
