/**
 * Fetches a URL and triggers a browser download of the response, under the
 * given file name.
 *
 * This exists because the same createObjectURL + temporary-<a> pattern was
 * duplicated across several editor menus (audio, video, image, draw.io,
 * Excalidraw) with no shared helper — this is a drop-in replacement for
 * that inline pattern, generic enough to fit any of those call sites.
 *
 * Throws if the response is not ok, so a 403/404 error body is never
 * silently saved to disk as if it were the real file.
 */
export async function downloadFile(
  url: string,
  fileName: string,
): Promise<void> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Download failed with status ${res.status}`);
  }

  const blob = await res.blob();
  const blobUrl = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(blobUrl);
}
