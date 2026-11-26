/** Longest side of a stored photo, in pixels. */
const MAX_SIDE = 1280;
const JPEG_QUALITY = 0.82;

export interface ScaledImage {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Draws an image source onto a canvas no larger than MAX_SIDE and encodes it
 * as JPEG. Runs entirely in the browser, so it works with no connection.
 */
async function encode(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): Promise<ScaledImage> {
  if (sourceWidth === 0 || sourceHeight === 0) {
    throw new Error("The image has no pixels.");
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(sourceWidth, sourceHeight));
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not draw the image.");
  // JPEG has no transparency, so transparent pixels become white, not black.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );
  if (!blob) throw new Error("This browser could not encode the image.");
  return { blob, width, height };
}

/** Downscales a picked or dropped image file. Throws if it is not an image. */
export async function scaleFile(file: Blob): Promise<ScaledImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const kind = file.type.startsWith("image/")
      ? `${file.type.slice(6).toUpperCase()} files`
      : "That file";
    throw new Error(
      `${kind} could not be opened by Chrome. Use a JPEG, PNG or WebP photo.`,
    );
  }
  try {
    return await encode(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/** Captures the current frame of a playing camera preview. */
export function scaleVideoFrame(video: HTMLVideoElement): Promise<ScaledImage> {
  if (
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    video.videoWidth === 0
  ) {
    return Promise.reject(
      new Error("The camera is still starting. Try again in a moment."),
    );
  }
  return encode(video, video.videoWidth, video.videoHeight);
}

export function isQuotaError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "QuotaExceededError";
}

/** Human-readable size, for storage messages. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
