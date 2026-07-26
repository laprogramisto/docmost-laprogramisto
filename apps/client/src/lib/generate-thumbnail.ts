// Thumbnails are generated entirely in the browser, before the file ever
// leaves the client — createImageBitmap + canvas are native APIs supported
// in every evergreen browser, no library needed. This is why there's no
// "thumbnail pending" state anywhere in the UI: by the time the upload
// request is sent, the thumbnail already exists.
const THUMBNAIL_MAX_WIDTH = 400;
const THUMBNAIL_QUALITY = 0.8;

/**
 * Returns a small JPEG thumbnail Blob for the given image file, or null if
 * the file isn't an image or the browser fails to decode it (corrupt file,
 * unsupported format, etc). Failing soft is deliberate: a missing thumbnail
 * just means the gallery falls back to the full-size image for that one
 * item — it should never block the upload itself.
 */
export async function generateThumbnail(file: File): Promise<Blob | null> {
  if (!file.type.startsWith("image/")) {
    return null;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }

  try {
    const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(bitmap, 0, 0, width, height);

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", THUMBNAIL_QUALITY);
    });
  } finally {
    bitmap.close();
  }
}
