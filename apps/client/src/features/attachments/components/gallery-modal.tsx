import React, { useEffect, useRef, useState } from "react";
import {
  Modal,
  SimpleGrid,
  Image,
  Text,
  TextInput,
  NumberInput,
  Popover,
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
} from "@mantine/core";
import {
  IconUpload,
  IconDownload,
  IconTrash,
  IconPhoto,
  IconSettings,
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
import { useWorkspaceImagesQuery, useGallerySettingsQuery, useUpdateGallerySettingsMutation, DEFAULT_GALLERY_SETTINGS } from "@/features/attachments/queries/attachment-query.ts";
import {
  uploadLibraryImage,
  deleteWorkspaceImage,
  renameWorkspaceImage,
} from "@/features/attachments/services";
import { uploadFile } from "@/features/page/services/page-service.ts";
import { getFileUrl } from "@/lib/config.ts";
import { downloadFile } from "@/lib/download-file.ts";
import { generateThumbnail } from "@/lib/generate-thumbnail.ts";
import { useSpaceQuery } from "@/features/space/queries/space-query.ts";
import { useSpaceAbility } from "@/features/space/permissions/use-space-ability.ts";
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
const UPLOAD_CONCURRENCY = 5;
const DELETE_CONCURRENCY = 5;

interface GalleryModalProps {
  opened: boolean;
  onClose: () => void;
  spaceId: string;
  pageId?: string;
  onSelect?: (url: string) => void;
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
  const updateGallerySettingsMutation = useUpdateGallerySettingsMutation();
  const [settingsPopoverOpened, setSettingsPopoverOpened] = useState(false);
  const [draftMaxBulkFiles, setDraftMaxBulkFiles] = useState<number>(
    maxBulkFiles,
  );
  const [draftPageSize, setDraftPageSize] = useState<number>(
    gallerySettings?.defaultPageSize ?? DEFAULT_GALLERY_SETTINGS.defaultPageSize,
  );
  const [draftRateLimit, setDraftRateLimit] = useState<number>(
    gallerySettings?.rateLimitPerMinute ??
      DEFAULT_GALLERY_SETTINGS.rateLimitPerMinute,
  );

  const openSettingsPopover = () => {
    // Re-seed the draft from the latest known values every time the panel
    // opens, rather than once on mount — otherwise a previous edit made in
    // another tab/session wouldn't be reflected if the popover happened to
    // mount before that data arrived.
    setDraftMaxBulkFiles(maxBulkFiles);
    setDraftPageSize(
      gallerySettings?.defaultPageSize ?? DEFAULT_GALLERY_SETTINGS.defaultPageSize,
    );
    setDraftRateLimit(
      gallerySettings?.rateLimitPerMinute ??
        DEFAULT_GALLERY_SETTINGS.rateLimitPerMinute,
    );
    setSettingsPopoverOpened(true);
  };

  const saveGallerySettings = () => {
    updateGallerySettingsMutation.mutate(
      {
        maxBulkUploadFiles: draftMaxBulkFiles,
        defaultPageSize: draftPageSize,
        rateLimitPerMinute: draftRateLimit,
      },
      {
        onSuccess: () => setSettingsPopoverOpened(false),
        onError: () =>
          notifications.show({
            color: "red",
            message: t("Failed to update gallery settings"),
          }),
      },
    );
  };

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
  // Only relevant when onSelect is set (cover-picker context): lets the user
  // switch from "click applies as cover" to "click toggles selection", so
  // bulk delete/download stays reachable even while picking a cover.
  const [pickerSelectionMode, setPickerSelectionMode] = useState(false);
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

  // In the standalone gallery (no onSelect), clicking a thumbnail always
  // toggles selection — there's no "apply as cover" behaviour to conflict
  // with. In the cover-picker context, that only happens once the user
  // explicitly switches into selection mode via the "Select" button.
  const isSelectionMode = (!onSelect || pickerSelectionMode) && canManageGallery;

  // The button that calls this only appears when selectedIds is empty (see
  // the merged Select all / Cancel control below), so this only ever needs
  // to select — the "deselect everything" case is now handled by Cancel.
  const selectAll = () => {
    setSelectedIds(new Set(filteredItems.map((item) => item.id)));
  };

  const exitSelectionMode = () => {
    setSelectedIds(new Set());
    setPickerSelectionMode(false);
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

      const hasSelectionStateToExit =
        selectedIds.size > 0 || (Boolean(onSelect) && pickerSelectionMode);

      if (isSelectionMode && hasSelectionStateToExit) {
        e.stopPropagation();
        e.preventDefault();
        exitSelectionMode();
        return;
      }

      onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [opened, isSelectionMode, selectedIds, onSelect, pickerSelectionMode, onClose]);

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

  const processFiles = async (fileList: File[]) => {
    let files = fileList;
    if (files.length === 0) return;

    if (files.length > maxBulkFiles) {
      notifications.show({
        color: "yellow",
        message: t(
          "You can upload up to {{max}} images at once. The rest of your selection was ignored — please upload them in a separate batch.",
          { max: maxBulkFiles },
        ),
      });
      files = files.slice(0, maxBulkFiles);
    }

    const toUpload: File[] = [];

    for (const file of files) {
      if (!ALLOWED_COVER_MIME_TYPES.includes(file.type)) continue;
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
      onSelect?.(url);
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

  const startEditing = (attachmentId: string, currentName: string) => {
    setEditingId(attachmentId);
    setEditingValue(currentName);
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
      onClose={onClose}
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
              {canManageGallery && (
                <Popover
                  opened={settingsPopoverOpened}
                  onChange={setSettingsPopoverOpened}
                  withArrow
                  position="bottom-end"
                >
                  <Popover.Target>
                    <ActionIcon
                      size="input-xs"
                      variant="default"
                      onClick={() =>
                        settingsPopoverOpened
                          ? setSettingsPopoverOpened(false)
                          : openSettingsPopover()
                      }
                      aria-label={t("Gallery settings")}
                    >
                      <IconSettings size={16} />
                    </ActionIcon>
                  </Popover.Target>
                  <Popover.Dropdown>
                    <Stack gap="xs" w={260}>
                      <Text size="sm" fw={500}>
                        {t("Gallery settings")}
                      </Text>
                      <NumberInput
                        label={t("Max files per bulk upload")}
                        size="xs"
                        min={1}
                        max={500}
                        value={draftMaxBulkFiles}
                        onChange={(v) =>
                          setDraftMaxBulkFiles(typeof v === "number" ? v : 1)
                        }
                      />
                      <NumberInput
                        label={t("Images per page")}
                        size="xs"
                        min={6}
                        max={200}
                        value={draftPageSize}
                        onChange={(v) =>
                          setDraftPageSize(typeof v === "number" ? v : 6)
                        }
                      />
                      <NumberInput
                        label={t("Requests per minute")}
                        size="xs"
                        min={10}
                        max={1000}
                        value={draftRateLimit}
                        onChange={(v) =>
                          setDraftRateLimit(typeof v === "number" ? v : 10)
                        }
                      />
                      <Group justify="flex-end" gap="xs" mt="xs">
                        <Button
                          size="xs"
                          variant="default"
                          onClick={() => setSettingsPopoverOpened(false)}
                        >
                          {t("Cancel")}
                        </Button>
                        <Button
                          size="xs"
                          onClick={saveGallerySettings}
                          loading={updateGallerySettingsMutation.isPending}
                        >
                          {t("Save")}
                        </Button>
                      </Group>
                    </Stack>
                  </Popover.Dropdown>
                </Popover>
              )}
              {onSelect && !pickerSelectionMode && canManageGallery && (
                isMobile ? (
                  <ActionIcon
                    size="input-xs"
                    variant="default"
                    onClick={() => setPickerSelectionMode(true)}
                    aria-label={t("Select")}
                  >
                    <IconSquareCheck size={14} />
                  </ActionIcon>
                ) : (
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={<IconSquareCheck size={14} />}
                    onClick={() => setPickerSelectionMode(true)}
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
                      loading={uploading}
                      disabled={uploading}
                    >
                      {uploading
                        ? `${progress.done}/${progress.total}`
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

                  return (
                    <Card
                      key={attachment.id}
                      p={0}
                      radius="sm"
                      className={classes.card}
                      data-selected={isSelected || undefined}
                      style={{ cursor: "pointer" }}
                      onClick={(e) => {
                        if (isSelectionMode) {
                          handleItemClick(attachment.id, index, e.shiftKey);
                          return;
                        }
                        if (onSelect) {
                          onSelect(url);
                          onClose();
                        }
                      }}
                    >
                      <Box className={classes.thumbWrapper}>
                        <LoadingOverlay visible={deletingId === attachment.id} />
                        <Image
                          src={`${getFileUrl(url)}?variant=thumbnail`}
                          fallbackSrc={getFileUrl(url)}
                          alt={attachment.fileName}
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
                          {canManageGallery && (
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
                            {attachment.fileName}
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
