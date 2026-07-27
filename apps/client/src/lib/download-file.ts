/**
 * Fetches a URL and triggers a browser download of the response, under the
 * given file name.
 *
 * This exists because the same createObjectURL + temporary-<a> pattern was
 * duplicated across several editor menus (audio, video, image, draw.io,
 * Excalidraw) with no shared helper. It was introduced for the Gallery/
 * cover-photo feature (page-cover.tsx, gallery-modal.tsx) and is written
 * generic enough to be a drop-in replacement anywhere that pattern already
 * exists.
 *
 * Deliberately NOT wired into those pre-existing call sites as part of
 * this change — introducing the helper is in scope, migrating unrelated,
 * already-working code to use it is a separate, intentionally deferred
 * follow-up so this change stays scoped to the feature it was written for.
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
