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
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspaceImagesQuery } from "@/features/attachments/queries/attachment-query.ts";
import {
  uploadLibraryImage,
  deleteWorkspaceImage,
  renameWorkspaceImage,
} from "@/features/attachments/services";
import { uploadFile } from "@/features/page/services/page-service.ts";
import { getFileUrl } from "@/lib/config.ts";
import { notifications } from "@mantine/notifications";
import { modals } from "@mantine/modals";
import classes from "./gallery-modal.module.css";

const MAX_BULK_FILES = 100;
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

function downloadFile(url: string, fileName: string) {
  fetch(url, { credentials: "include" })
    .then((res) => res.blob())
    .then((blob) => {
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = fileName;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(blobUrl);
    });
}

export default function GalleryModal({
  opened,
  onClose,
  spaceId,
  pageId,
  onSelect,
}: GalleryModalProps) {
  const { t } = useTranslation();
  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useWorkspaceImagesQuery();
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
  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const lastClickedIndexRef = useRef<number | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["workspace-images"] });

  const allItems = (data?.pages ?? []).flatMap((page) => page.items);

  const filteredItems = allItems.filter((item) =>
    item.fileName.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  // In the standalone gallery (no onSelect), clicking a thumbnail always
  // toggles selection — there's no "apply as cover" behaviour to conflict
  // with. In the cover-picker context, that only happens once the user
  // explicitly switches into selection mode via the "Select" button.
  const isSelectionMode = !onSelect || pickerSelectionMode;

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

    if (files.length > MAX_BULK_FILES) {
      notifications.show({
        color: "yellow",
        message: t(
          "You can upload up to {{max}} images at once. The rest of your selection was ignored — please upload them in a separate batch.",
          { max: MAX_BULK_FILES },
        ),
      });
      files = files.slice(0, MAX_BULK_FILES);
    }

    // Duplicate check only covers images already loaded on the client
    // (the pages fetched so far), not the entire workspace if there are
    // more pages beyond what's currently loaded.
    const existing = new Set(allItems.map((i) => `${i.fileName}:${i.fileSize}`));
    const toUpload: File[] = [];
    let skipped = 0;

    for (const file of files) {
      if (!file.type.includes("image/")) continue;
      const key = `${file.name}:${file.size}`;
      if (existing.has(key)) {
        skipped++;
        continue;
      }
      existing.add(key);
      toUpload.push(file);
    }

    if (skipped > 0) {
      notifications.show({
        color: "gray",
        message: t("{{count}} duplicate image(s) skipped", { count: skipped }),
      });
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
          const attachment = await uploadLibraryImage(file, spaceId, controller.signal);
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
    if (!file.type.includes("image/")) {
      notifications.show({ color: "red", message: t("Please select an image file") });
      return;
    }

    try {
      const attachment = await uploadFile(file, pageId, undefined, "cover");
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
      title: t("Delete {{count}} image(s)?", { count }),
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
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`${classes.panel} ${isDragging ? classes.dropzoneActive : ""}`}
        >
          {isDragging && (
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

            <Group gap="xs" wrap="nowrap" className={classes.toolbarActions}>
              {onSelect && !pickerSelectionMode && (
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => setPickerSelectionMode(true)}
                >
                  {t("Select")}
                </Button>
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
                  <Button
                    size="xs"
                    variant="default"
                    onClick={selectedIds.size > 0 ? exitSelectionMode : selectAll}
                    disabled={selectedIds.size === 0 && filteredItems.length === 0}
                  >
                    {selectedIds.size > 0 ? t("Cancel") : t("Select all")}
                  </Button>
                  {selectedIds.size > 0 && (
                    <Button
                      size="xs"
                      color="red"
                      leftSection={<IconTrash size={14} />}
                      onClick={handleBulkDelete}
                      loading={bulkDeleting}
                    >
                      {bulkDeleting
                        ? `${progress.done}/${progress.total}`
                        : t("Delete ({{count}})", { count: selectedIds.size })}
                    </Button>
                  )}
                </>
              )}
              {uploading && (
                <Button size="xs" variant="default" onClick={cancelUpload}>
                  {t("Cancel")}
                </Button>
              )}
              <Button
                size="xs"
                leftSection={<IconUpload size={14} />}
                onClick={() => inputRef.current?.click()}
                loading={uploading}
                disabled={uploading}
              >
                {uploading ? `${progress.done}/${progress.total}` : t("Upload images")}
              </Button>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={handleBulkUpload}
              />
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
            <>
              <SimpleGrid cols={{ base: 2, xs: 3, sm: 4, md: 6 }} spacing="sm">
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
                        onSelect?.(url);
                        onClose();
                      }}
                    >
                      <Box className={classes.thumbWrapper}>
                        <LoadingOverlay visible={deletingId === attachment.id} />
                        <Image
                          src={getFileUrl(url)}
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
                              downloadFile(getFileUrl(url), attachment.fileName);
                            }}
                          >
                            <IconDownload size={12} />
                          </ActionIcon>
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
                          <ActionIcon
                            size="sm"
                            variant="subtle"
                            className={classes.editButton}
                            onClick={() => startEditing(attachment.id, attachment.fileName)}
                          >
                            <IconPencil size={12} />
                          </ActionIcon>
                        </Group>
                      )}
                    </Card>
                  );
                })}
              </SimpleGrid>

              {hasNextPage && !searchQuery && (
                <Center mt="md">
                  <Button
                    variant="default"
                    size="xs"
                    onClick={() => fetchNextPage()}
                    loading={isFetchingNextPage}
                  >
                    {t("Load more")}
                  </Button>
                </Center>
              )}
            </>
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
                accept="image/*"
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
