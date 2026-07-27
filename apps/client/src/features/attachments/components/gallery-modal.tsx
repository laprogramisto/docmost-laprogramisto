import React, { useEffect, useRef, useState } from "react";
import {
  Modal,
  SimpleGrid,
  Image,
  Text,
  TextInput,
  Center,
  Loader,
  Card,
  Box,
  Button,
  Group,
  Stack,
  Tabs,
  ActionIcon,
  LoadingOverlay,
  Progress,
} from "@mantine/core";
import {
  IconUpload,
  IconDownload,
  IconTrash,
  IconPhoto,
  IconCloudUpload,
  IconSearch,
  IconPencil,
  IconCheck,
  IconX,
  IconSquareCheck,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useMediaQuery, useIntersection, useDebouncedValue } from "@mantine/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspaceImagesQuery, useGallerySettingsQuery, DEFAULT_GALLERY_SETTINGS } from "@/features/attachments/queries/attachment-query.ts";
import {
  uploadLibraryImage,
  deleteWorkspaceImage,
  renameWorkspaceImage,
} from "@/features/attachments/services";
import { uploadFile } from "@/features/page/services/page-service.ts";
import { getFileUrl, getFileUploadSizeLimit } from "@/lib/config.ts";
import { formatBytes } from "@/lib";
import { IAttachment } from "@/features/attachments/types/attachment.types.ts";
import { downloadFile } from "@/lib/download-file.ts";
import { generateThumbnail } from "@/lib/generate-thumbnail.ts";
import { useSpaceQuery } from "@/features/space/queries/space-query.ts";
import { useSpaceAbility } from "@/features/space/permissions/use-space-ability.ts";
import useUserRole from "@/hooks/use-user-role.tsx";
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from "@/features/space/permissions/permissions.type.ts";
import { notifications } from "@mantine/notifications";
import { modals } from "@mantine/modals";
import classes from "./gallery-modal.module.css";

// Fallback while gallery settings haven't loaded yet — matches
// DEFAULT_GALLERY_SETTINGS.maxBulkUploadFiles, kept as a local constant only
// for readability at this specific call site.
// Mirrors validImageExtensions in attachment.constants.ts (server-side) —
// kept in sync manually since the two run in different runtimes. Anything
// accepted here but rejected server-side would be a confusing dead end for
// the user (file picked, upload attempted, then a server error).
const ALLOWED_COVER_MIME_TYPES = ["image/jpeg", "image/png"];
// Same limit the server enforces (environmentService.getFileUploadSizeLimit,
// already exposed to the client via lib/config.ts) — checked here too so a
// too-large file is rejected immediately, with a clear reason, rather than
// only failing later against the server's own check.
const maxUploadBytes = getFileUploadSizeLimit();
const maxUploadSizeLabel = formatBytes(maxUploadBytes);
const UPLOAD_CONCURRENCY = 5;
const DELETE_CONCURRENCY = 5;

// What onSelect receives when a cover is picked (from either tab). `url`
// is provided only so the caller (PageCover) can render the new cover
// immediately, optimistically — it is never sent back to the server.
// attachmentId is the only thing that ever reaches the API (see
// IPageInput.coverAttachmentId / PageService.resolveCoverAttachment); a
// raw URL is not something the page-update endpoint accepts.
export interface GallerySelection {
  attachmentId: string;
  url: string;
}

// The Gallery only ever needs to show/edit a name without its extension
// (see the name row and rename input below) — this never touches what's
// actually stored server-side. Renaming re-appends the original extension
// server-side; see AttachmentController.renameImage.
function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^./]+$/, "");
}

interface GalleryModalProps {
  opened: boolean;
  onClose: () => void;
  spaceId: string;
  pageId?: string;
  onSelect?: (selection: GallerySelection) => void;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal,
) {
  let index = 0;
  const runners = new Array(Math.min(limit, items.length))
    .fill(null)
    .map(async () => {
      while (index < items.length) {
        if (signal?.aborted) return;
        const current = items[index++];
        await worker(current);
      }
    });
  await Promise.all(runners);
}


export default function GalleryModal({
  opened,
  onClose,
  spaceId,
  pageId,
  onSelect,
}: GalleryModalProps) {
  const { t } = useTranslation();
  const isMobile = useMediaQuery("(max-width: 47.99em)");
  // Scoped to the Covers tab only: bulk upload, select, delete and rename
  // there act on the whole space's shared gallery, matching the
  // SpaceCaslAction.Manage/SpaceCaslSubject.Page guard the server already
  // enforces for those same actions. The Upload tab is deliberately left
  // alone — it applies a cover to one specific page and is already gated
  // by that page's own edit permission before this modal ever opens.
  const { data: space } = useSpaceQuery(spaceId);
  const spaceAbility = useSpaceAbility(space?.membership?.permissions);
  const canManageGallery = spaceAbility.can(
    SpaceCaslAction.Manage,
    SpaceCaslSubject.Page,
  );
  const { data: gallerySettings } = useGallerySettingsQuery();
  const maxBulkFiles =
    gallerySettings?.maxBulkUploadFiles ??
    DEFAULT_GALLERY_SETTINGS.maxBulkUploadFiles;
  // Deletion is gated more strictly than the rest of the gallery's write
  // actions when the workspace opts into "restrict gallery deletion to
  // owners" — same shape of fix as the settings-page gating: don't show a
  // control the server will 403 on. Selection mode's only purpose today is
  // enabling bulk delete, so it's gated on the same flag.
  const { isOwner } = useUserRole();
  const canDeleteFromGallery =
    canManageGallery &&
    (!gallerySettings?.restrictDeleteToOwners || isOwner);

  // Passed to useIntersection as `root`. A plain useRef wouldn't work here:
  // its .current is still null on the render where this container first
  // mounts, so the observer would be created against the wrong root (or
  // none). Storing the node in state forces a re-render once it's actually
  // attached, and useIntersection re-creates its observer with the real
  // element.
  const [gridScrollEl, setGridScrollEl] = useState<HTMLDivElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Debounced before it ever reaches the server — searching now hits the
  // database on every change instead of filtering an already-loaded page
  // client-side, so this avoids a request per keystroke.
  const [debouncedSearchQuery] = useDebouncedValue(searchQuery, 300);
  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useWorkspaceImagesQuery(gallerySettings?.defaultPageSize, debouncedSearchQuery);
  const { ref: loadMoreSentinelRef, entry: loadMoreEntry } = useIntersection({
    root: gridScrollEl,
    rootMargin: "200px",
    threshold: 0,
  });

  useEffect(() => {
    if (loadMoreEntry?.isIntersecting && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [loadMoreEntry?.isIntersecting, hasNextPage, isFetchingNextPage, fetchNextPage]);
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadTabInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Explicit selection mode, entered only via the "Select" button — in
  // both the standalone Gallery (no onSelect) and the cover-picker
  // context (onSelect set). Previously the standalone case skipped this
  // and was permanently "in selection mode" the moment the modal opened
  // (since a plain click had no other job to do there), which meant a
  // single click on any image immediately multi-selected it with no
  // "Select" button ever having been shown — inconsistent with the picker
  // context, where the same click applies that image as the cover until
  // you explicitly opt into selecting.
  const [selectionMode, setSelectionMode] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const lastClickedIndexRef = useRef<number | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["workspace-images"] });

  const allItems = (data?.pages ?? []).flatMap((page) => page.items);

  // Filtering now happens server-side (attachment.repo.ts, ilike on
  // fileName) — allItems already reflects the current search. Kept as its
  // own name rather than renaming every downstream reference to it.
  const filteredItems = allItems;

  const isSelectionMode = selectionMode && canDeleteFromGallery;

  // The button that calls this only appears when selectedIds is empty (see
  // the merged Select all / Cancel control below), so this only ever needs
  // to select — the "deselect everything" case is now handled by Cancel.
  const selectAll = () => {
    setSelectedIds(new Set(filteredItems.map((item) => item.id)));
  };

  const exitSelectionMode = () => {
    setSelectedIds(new Set());
    setSelectionMode(false);
  };

  // Closing mid-bulk-upload would unmount this component while several
  // uploadLibraryImage requests are still in flight — those requests
  // still complete server-side (the files really do get saved), but
  // nothing is left around to call invalidate() once they resolve, since
  // the whole closure this effect lives in is gone. The uploaded files
  // then only become visible the next time the Gallery happens to be
  // reopened and refetches. Blocking close while uploading is in progress
  // avoids that gap entirely; cancelUpload (already exposed via the
  // Cancel button) remains the correct way to stop early.
  const handleClose = () => {
    if (uploading) {
      notifications.show({
        color: "yellow",
        message: t(
          "Please wait for the upload to finish, or cancel it, before closing.",
        ),
      });
      return;
    }
    onClose();
  };

  // Escape, two levels:
  // 1st press — if there's a selection state to back out of (something
  //   selected, or picker selection mode entered with nothing selected yet —
  //   the gap the merged Select all/Cancel button leaves open), back out of
  //   it and stop there.
  // 2nd press (or 1st, if there was nothing to back out of) — close the
  //   modal, same as Mantine's default closeOnEscape would have done.
  // Renaming (editingId) is intentionally excluded here: its own input
  // already handles Escape and stops propagation, so this listener never
  // sees that keypress while a rename is in progress.
  useEffect(() => {
    if (!opened) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;

      const hasSelectionStateToExit = selectedIds.size > 0 || selectionMode;

      if (isSelectionMode && hasSelectionStateToExit) {
        e.stopPropagation();
        e.preventDefault();
        exitSelectionMode();
        return;
      }

      handleClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [opened, isSelectionMode, selectedIds, selectionMode, uploading]);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Click = toggle just this item, remembering its position.
  // Shift+click = extend the selection to every item between the last
  // clicked one and this one (inclusive), matching the usual file-manager
  // convention — it adds to the existing selection rather than replacing it.
  const handleItemClick = (id: string, index: number, shiftKey: boolean) => {
    if (shiftKey && lastClickedIndexRef.current !== null) {
      const start = Math.min(lastClickedIndexRef.current, index);
      const end = Math.max(lastClickedIndexRef.current, index);
      const rangeIds = filteredItems.slice(start, end + 1).map((item) => item.id);
      setSelectedIds((prev) => new Set([...prev, ...rangeIds]));
    } else {
      toggleSelected(id);
    }
    lastClickedIndexRef.current = index;
  };

  const clearSelection = () => setSelectedIds(new Set());

  // Checked client-side before ever starting the network request, so a
  // rejection is immediate and carries a specific reason — rather than
  // silently skipping the file (the previous MIME-only filter) or letting
  // it fail later against the server's own limit with a generic error.
  const validateFileBeforeUpload = (
    file: File,
  ): { ok: boolean; reason?: string } => {
    if (!ALLOWED_COVER_MIME_TYPES.includes(file.type)) {
      return {
        ok: false,
        reason: t("Unsupported file type ({{type}})", {
          type: file.type || t("unknown"),
        }),
      };
    }
    if (file.size > maxUploadBytes) {
      return {
        ok: false,
        reason: t("File is too large (max {{max}})", {
          max: maxUploadSizeLabel,
        }),
      };
    }
    return { ok: true };
  };

  // Inserts a newly-uploaded attachment straight into the first page of
  // the cached list, so it appears in the grid the instant its upload
  // resolves — rather than waiting for the whole batch to finish and
  // invalidating once at the end. A plain invalidate() per file would
  // also work, but would mean a full extra request per file just to
  // fetch back something the response already handed us.
  const insertUploadedItem = (attachment: IAttachment) => {
    // Skipped while a search filter is active: the new file's name has no
    // reason to match whatever the user typed, so forcing it into a
    // filtered view would misrepresent what that filter actually matches.
    // invalidate() at the end of the batch (or the user clearing the
    // search) is what surfaces it in that case.
    if (debouncedSearchQuery) return;

    queryClient.setQueryData(
      ["workspace-images", ""],
      (data: any) => {
        if (!data) return data;
        const [firstPage, ...restPages] = data.pages;
        if (!firstPage) return data;
        return {
          ...data,
          pages: [
            { ...firstPage, items: [attachment, ...firstPage.items] },
            ...restPages,
          ],
        };
      },
    );
  };

  const processFiles = async (fileList: File[]) => {
    const files = fileList;
    if (files.length === 0) return;

    if (files.length > maxBulkFiles) {
      notifications.show({
        color: "red",
        message: t(
          "You selected {{count}} images, but only {{max}} can be uploaded at once. Please select {{max}} or fewer and try again.",
          { count: files.length, max: maxBulkFiles },
        ),
      });
      return;
    }

    const toUpload: File[] = [];

    for (const file of files) {
      const result = validateFileBeforeUpload(file);
      if (!result.ok) {
        notifications.show({
          color: "red",
          message: t("Skipped {{name}}: {{reason}}", {
            name: file.name,
            reason: result.reason,
          }),
        });
        continue;
      }
      toUpload.push(file);
    }

    if (toUpload.length === 0) return;

    const controller = new AbortController();
    uploadAbortControllerRef.current = controller;

    setUploading(true);
    setProgress({ done: 0, total: toUpload.length });

    await runWithConcurrency(
      toUpload,
      UPLOAD_CONCURRENCY,
      async (file) => {
        try {
          const thumbnail = await generateThumbnail(file);
          const attachment = await uploadLibraryImage(
            file,
            spaceId,
            controller.signal,
            thumbnail,
          );
          if (!attachment?.id) {
            throw new Error("Empty response");
          }
          insertUploadedItem(attachment);
        } catch (err: any) {
          // A deliberate cancellation isn't a failure worth a notification
          // per file — the "cancelled" state is already communicated once
          // via the button itself.
          if (err?.code === "ERR_CANCELED" || controller.signal.aborted) {
            return;
          }
          notifications.show({
            color: "red",
            message: err?.response?.data?.message ?? t("Failed to upload {{name}}", { name: file.name }),
          });
        }
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      },
      controller.signal,
    );

    uploadAbortControllerRef.current = null;
    setUploading(false);
    // Reconciles the optimistic inserts above against the server's real
    // ordering/pagination (e.g. two files finishing in a different order
    // than they were queued) — inserts already made the grid update
    // immediately per file, this just corrects any drift once the whole
    // batch has settled.
    invalidate();
  };

  const cancelUpload = () => {
    uploadAbortControllerRef.current?.abort();
  };

  const handleBulkUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    processFiles(files);
  };

  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    // Only clear the flag once the pointer actually leaves the drop zone,
    // not when it moves over a child element inside it.
    if (e.currentTarget === e.target) setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    processFiles(files);
  };

  const processSingleCoverUpload = async (file?: File) => {
    if (!file || !pageId) return;
    if (!ALLOWED_COVER_MIME_TYPES.includes(file.type)) {
      notifications.show({ color: "red", message: t("Please select an image file") });
      return;
    }

    try {
      const thumbnail = await generateThumbnail(file);
      const attachment = await uploadFile(file, pageId, undefined, "cover", thumbnail);
      const url = `/api/files/${attachment.id}/${attachment.fileName}`;
      invalidate();
      onSelect?.({ attachmentId: attachment.id, url });
      onClose();
    } catch (err: any) {
      notifications.show({
        color: "red",
        message: err?.response?.data?.message ?? t("Failed to upload cover"),
      });
    }
  };

  const handleUploadTabFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    processSingleCoverUpload(file);
  };

  const [isDraggingSingle, setIsDraggingSingle] = useState(false);

  const handleSingleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isDraggingSingle) setIsDraggingSingle(true);
  };

  const handleSingleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.currentTarget === e.target) setIsDraggingSingle(false);
  };

  const handleSingleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingSingle(false);
    processSingleCoverUpload(e.dataTransfer?.files?.[0]);
  };

  const performDelete = async (attachmentId: string) => {
    setDeletingId(attachmentId);
    try {
      await deleteWorkspaceImage(attachmentId);
      invalidate();
      setSelectedIds((prev) => {
        if (!prev.has(attachmentId)) return prev;
        const next = new Set(prev);
        next.delete(attachmentId);
        return next;
      });
    } catch (err: any) {
      notifications.show({
        color: "red",
        message: err?.response?.data?.message ?? t("Failed to delete image"),
      });
    } finally {
      setDeletingId(null);
    }
  };

  const handleDelete = (attachmentId: string) => {
    modals.openConfirmModal({
      title: t("Delete this image?"),
      children: (
        <Text size="sm">
          {t("This will permanently delete the image. This action is irreversible.")}
        </Text>
      ),
      centered: true,
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => performDelete(attachmentId),
    });
  };

  const performBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    setBulkDeleting(true);
    setProgress({ done: 0, total: ids.length });

    await runWithConcurrency(ids, DELETE_CONCURRENCY, async (id) => {
      try {
        await deleteWorkspaceImage(id);
      } catch (err: any) {
        notifications.show({
          color: "red",
          message: err?.response?.data?.message ?? t("Failed to delete image"),
        });
      }
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    });

    setBulkDeleting(false);
    clearSelection();
    invalidate();
  };

  const handleBulkDelete = () => {
    const count = selectedIds.size;
    if (count === 0) return;

    modals.openConfirmModal({
      title: t("Delete {{count}} images?", { count }),
      children: (
        <Text size="sm">
          {t("This will permanently delete the selected images. This action is irreversible.")}
        </Text>
      ),
      centered: true,
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: performBulkDelete,
    });
  };

  // currentFileName is the full stored name (with extension) — the input
  // is seeded with the extension-less display name (stripExtension) so the
  // user never has to type or preserve an extension they can't see; the
  // server re-appends attachment.fileExt when saving (see
  // AttachmentController.renameImage).
  const startEditing = (attachmentId: string, currentFileName: string) => {
    setEditingId(attachmentId);
    setEditingValue(stripExtension(currentFileName));
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditingValue("");
  };

  const saveEditing = async (attachmentId: string) => {
    const trimmed = editingValue.trim();
    if (!trimmed) {
      cancelEditing();
      return;
    }
    try {
      await renameWorkspaceImage(attachmentId, trimmed);
      invalidate();
    } catch (err: any) {
      notifications.show({
        color: "red",
        message: err?.response?.data?.message ?? t("Failed to rename image"),
      });
    } finally {
      cancelEditing();
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={t("Gallery")}
      size="90%"
      centered={false}
      yOffset="8dvh"
      closeOnEscape={false}
    >
      <Tabs defaultValue="covers">
        <Tabs.List>
          <Tabs.Tab value="covers" leftSection={<IconPhoto size={14} />}>
            {t("Covers")}
          </Tabs.Tab>
          {onSelect && pageId && (
            <Tabs.Tab value="upload" leftSection={<IconCloudUpload size={14} />}>
              {t("Upload")}
            </Tabs.Tab>
          )}
        </Tabs.List>

        <Tabs.Panel
          value="covers"
          pt="md"
          onDragOver={canManageGallery ? handleDragOver : undefined}
          onDragLeave={canManageGallery ? handleDragLeave : undefined}
          onDrop={canManageGallery ? handleDrop : undefined}
          className={`${classes.panel} ${isDragging && canManageGallery ? classes.dropzoneActive : ""}`}
        >
          {isDragging && canManageGallery && (
            <Box className={classes.dropzoneOverlay}>
              <Text size="sm" fw={500}>
                {t("Drop images to upload")}
              </Text>
            </Box>
          )}
          <Group justify="space-between" mb="sm" wrap="nowrap" className={classes.toolbar}>
            <TextInput
              placeholder={t("Search images")}
              leftSection={<IconSearch size={14} />}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.currentTarget.value)}
              size="xs"
              className={classes.searchInput}
            />

            <Group gap="xs" className={classes.toolbarActions}>
              {!isSelectionMode && canDeleteFromGallery && (
                isMobile ? (
                  <ActionIcon
                    size="input-xs"
                    variant="default"
                    onClick={() => setSelectionMode(true)}
                    aria-label={t("Select")}
                  >
                    <IconSquareCheck size={14} />
                  </ActionIcon>
                ) : (
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={<IconSquareCheck size={14} />}
                    onClick={() => setSelectionMode(true)}
                  >
                    {t("Select")}
                  </Button>
                )
              )}
              {isSelectionMode && (
                <>
                  {/* Select all / Cancel are merged into a single control:
                      with nothing selected there's nothing to cancel out of
                      yet, so the button offers "Select all". As soon as one
                      item is selected, the same slot becomes "Cancel",
                      clearing the selection and exiting selection mode in
                      one action rather than exposing two separate buttons
                      that overlapped once everything was selected. */}
                  {isMobile ? (
                    <ActionIcon
                      size="input-xs"
                      variant="default"
                      onClick={selectedIds.size > 0 ? exitSelectionMode : selectAll}
                      disabled={selectedIds.size === 0 && filteredItems.length === 0}
                      aria-label={
                        selectedIds.size > 0 ? t("Cancel") : t("Select all")
                      }
                    >
                      {selectedIds.size > 0 ? (
                        <IconX size={14} />
                      ) : (
                        <IconSquareCheck size={14} />
                      )}
                    </ActionIcon>
                  ) : (
                    <Button
                      size="xs"
                      variant="default"
                      leftSection={
                        selectedIds.size > 0 ? (
                          <IconX size={14} />
                        ) : (
                          <IconSquareCheck size={14} />
                        )
                      }
                      onClick={selectedIds.size > 0 ? exitSelectionMode : selectAll}
                      disabled={selectedIds.size === 0 && filteredItems.length === 0}
                    >
                      {selectedIds.size > 0 ? t("Cancel") : t("Select all")}
                    </Button>
                  )}
                  {selectedIds.size > 0 && (
                    <Button
                      size="xs"
                      color="red"
                      leftSection={<IconTrash size={14} />}
                      onClick={handleBulkDelete}
                      loading={bulkDeleting}
                      aria-label={
                        isMobile
                          ? t("Delete {{count}} images", { count: selectedIds.size })
                          : undefined
                      }
                    >
                      {bulkDeleting
                        ? `${progress.done}/${progress.total}`
                        : isMobile
                          ? selectedIds.size
                          : t("Delete ({{count}})", { count: selectedIds.size })}
                    </Button>
                  )}
                </>
              )}
              {uploading && (
                isMobile ? (
                  <ActionIcon
                    size="input-xs"
                    variant="default"
                    onClick={cancelUpload}
                    aria-label={t("Cancel")}
                  >
                    <IconX size={14} />
                  </ActionIcon>
                ) : (
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={<IconX size={14} />}
                    onClick={cancelUpload}
                  >
                    {t("Cancel")}
                  </Button>
                )
              )}
              {canManageGallery && (
                <>
                  {isMobile && !uploading ? (
                    <ActionIcon
                      size="input-xs"
                      onClick={() => inputRef.current?.click()}
                      aria-label={t("Upload images")}
                    >
                      <IconUpload size={14} />
                    </ActionIcon>
                  ) : (
                    <Button
                      size="xs"
                      leftSection={<IconUpload size={14} />}
                      onClick={() => inputRef.current?.click()}
                      disabled={uploading}
                    >
                      {uploading
                        ? t("Uploading {{done}}/{{total}}", {
                            done: progress.done,
                            total: progress.total,
                          })
                        : t("Upload images")}
                    </Button>
                  )}
                  <input
                    ref={inputRef}
                    type="file"
                    accept="image/jpeg,image/png"
                    multiple
                    style={{ display: "none" }}
                    onChange={handleBulkUpload}
                  />
                </>
              )}
            </Group>
          </Group>

          {uploading && (
            <Stack gap={4} mb="sm">
              <Text size="xs" c="dimmed">
                {t("Uploading {{done}} of {{total}} images…", {
                  done: progress.done,
                  total: progress.total,
                })}
              </Text>
              <Progress
                value={
                  progress.total > 0
                    ? (progress.done / progress.total) * 100
                    : 0
                }
                size="sm"
              />
            </Stack>
          )}

          {isLoading && (
            <Center py="xl">
              <Loader size="sm" />
            </Center>
          )}

          {!isLoading && filteredItems.length === 0 && (
            <Text c="dimmed" size="sm">
              {t("No images found")}
            </Text>
          )}

          {!isLoading && filteredItems.length > 0 && (
            <Box ref={setGridScrollEl} className={classes.gridScroll}>
              <SimpleGrid cols={{ base: 1, xs: 2, sm: 4, md: 6 }} spacing="sm">
                {filteredItems.map((attachment, index) => {
                  const url = `/api/files/${attachment.id}/${attachment.fileName}`;
                  const isSelected = selectedIds.has(attachment.id);
                  const isEditing = editingId === attachment.id;
                  const displayName = stripExtension(attachment.fileName);

                  return (
                    <Card
                      key={attachment.id}
                      p={0}
                      radius="sm"
                      className={classes.card}
                      data-selected={isSelected || undefined}
                      style={{
                        cursor: isSelectionMode || onSelect ? "pointer" : "default",
                      }}
                      onClick={(e) => {
                        if (isSelectionMode) {
                          handleItemClick(attachment.id, index, e.shiftKey);
                          return;
                        }
                        if (onSelect) {
                          onSelect({ attachmentId: attachment.id, url });
                          onClose();
                        }
                      }}
                    >
                      <Box className={classes.thumbWrapper}>
                        <LoadingOverlay visible={deletingId === attachment.id} />
                        <Image
                          src={`${getFileUrl(url)}?variant=thumbnail`}
                          fallbackSrc={getFileUrl(url)}
                          alt={displayName}
                          radius="sm"
                          h={100}
                          fit="cover"
                          draggable={false}
                          loading="lazy"
                        />

                        <Group className={classes.actions} gap={4}>
                          <ActionIcon
                            size="sm"
                            variant="filled"
                            color="dark"
                            onClick={(e) => {
                              e.stopPropagation();
                              downloadFile(
                                getFileUrl(url),
                                attachment.fileName,
                              ).catch(() =>
                                notifications.show({
                                  color: "red",
                                  message: t("Failed to download image"),
                                }),
                              );
                            }}
                          >
                            <IconDownload size={12} />
                          </ActionIcon>
                          {canDeleteFromGallery && (
                            <ActionIcon
                              size="sm"
                              variant="filled"
                              color="red"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDelete(attachment.id);
                              }}
                            >
                              <IconTrash size={12} />
                            </ActionIcon>
                          )}
                        </Group>
                      </Box>

                      {isEditing ? (
                        <Group gap={2} px={2} pb={2} wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                          <TextInput
                            size="xs"
                            autoFocus
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveEditing(attachment.id);
                              if (e.key === "Escape") {
                                e.stopPropagation();
                                cancelEditing();
                              }
                            }}
                            style={{ flex: 1 }}
                          />
                          <ActionIcon size="sm" variant="subtle" onClick={() => saveEditing(attachment.id)}>
                            <IconCheck size={14} />
                          </ActionIcon>
                          <ActionIcon size="sm" variant="subtle" onClick={cancelEditing}>
                            <IconX size={14} />
                          </ActionIcon>
                        </Group>
                      ) : (
                        <Group
                          gap={2}
                          px={2}
                          pb={2}
                          wrap="nowrap"
                          className={classes.nameRow}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
                            {displayName}
                          </Text>
                          {canManageGallery && (
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              className={classes.editButton}
                              onClick={() => startEditing(attachment.id, attachment.fileName)}
                            >
                              <IconPencil size={12} />
                            </ActionIcon>
                          )}
                        </Group>
                      )}
                    </Card>
                  );
                })}
              </SimpleGrid>

              {hasNextPage && (
                <div ref={loadMoreSentinelRef} style={{ height: 1 }} />
              )}
              {isFetchingNextPage && (
                <Center mt="md">
                  <Loader size="sm" />
                </Center>
              )}
            </Box>
          )}
        </Tabs.Panel>

        {onSelect && pageId && (
          <Tabs.Panel
            value="upload"
            pt="md"
            onDragOver={handleSingleDragOver}
            onDragLeave={handleSingleDragLeave}
            onDrop={handleSingleDrop}
            className={`${classes.panel} ${isDraggingSingle ? classes.dropzoneActive : ""}`}
          >
            <Center py="xl" style={{ position: "relative", width: "100%" }}>
              {isDraggingSingle && (
                <Box className={classes.dropzoneOverlay}>
                  <Text size="sm" fw={500}>
                    {t("Drop an image to set as cover")}
                  </Text>
                </Box>
              )}
              <Stack align="center" gap="xs">
                <Button
                  leftSection={<IconCloudUpload size={16} />}
                  onClick={() => uploadTabInputRef.current?.click()}
                >
                  {t("Upload a file")}
                </Button>
                <Text size="xs" c="dimmed" ta="center" maw={340}>
                  {t(
                    "Unlike the Covers tab, this uploads a file from your device and applies it as this page's cover in one step. It's also added to the shared gallery afterwards, just like a Covers-tab upload. You can drag and drop an image here too.",
                  )}
                </Text>
              </Stack>
              <input
                ref={uploadTabInputRef}
                type="file"
                accept="image/jpeg,image/png"
                style={{ display: "none" }}
                onChange={handleUploadTabFile}
              />
            </Center>
          </Tabs.Panel>
        )}
      </Tabs>
    </Modal>
  );
}
