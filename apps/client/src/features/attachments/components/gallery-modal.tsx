import React, { useRef, useState } from "react";
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
  Tabs,
  ActionIcon,
  LoadingOverlay,
  Checkbox,
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
) {
  let index = 0;
  const runners = new Array(Math.min(limit, items.length))
    .fill(null)
    .map(async () => {
      while (index < items.length) {
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
  const { data, isLoading } = useWorkspaceImagesQuery();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadTabInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["workspace-images"] });

  const filteredItems = (data?.items ?? []).filter((item) =>
    item.fileName.toLowerCase().includes(searchQuery.toLowerCase()),
  );

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

  const clearSelection = () => setSelectedIds(new Set());

  const handleBulkUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    let files = Array.from(e.target.files ?? []);
    e.target.value = "";
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

    const existing = new Set(
      (data?.items ?? []).map((i) => `${i.fileName}:${i.fileSize}`),
    );
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

    setUploading(true);
    setProgress({ done: 0, total: toUpload.length });

    await runWithConcurrency(toUpload, UPLOAD_CONCURRENCY, async (file) => {
      try {
        const attachment = await uploadLibraryImage(file, spaceId);
        if (!attachment?.id) {
          throw new Error("Empty response");
        }
      } catch (err: any) {
        notifications.show({
          color: "red",
          message: err?.response?.data?.message ?? t("Failed to upload {{name}}", { name: file.name }),
        });
      }
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    });

    setUploading(false);
    invalidate();
  };

  const handleUploadTabFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !pageId) return;

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

  const handleDelete = async (attachmentId: string) => {
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

  const handleBulkDelete = async () => {
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
    <Modal opened={opened} onClose={onClose} title={t("Gallery")} size="90%" centered>
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

        <Tabs.Panel value="covers" pt="md">
          <Group justify="space-between" mb="sm" wrap="nowrap">
            <TextInput
              placeholder={t("Search images")}
              leftSection={<IconSearch size={14} />}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.currentTarget.value)}
              size="xs"
              style={{ flex: 1, maxWidth: 280 }}
            />

            <Group gap="xs" wrap="nowrap">
              {selectedIds.size > 0 && (
                <>
                  <Button size="xs" variant="default" onClick={clearSelection}>
                    {t("Cancel")}
                  </Button>
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
                </>
              )}
              <Button
                size="xs"
                leftSection={<IconUpload size={14} />}
                onClick={() => inputRef.current?.click()}
                loading={uploading}
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
            <SimpleGrid cols={6} spacing="sm">
              {filteredItems.map((attachment) => {
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
                    style={onSelect ? { cursor: "pointer" } : undefined}
                    onClick={
                      onSelect
                        ? () => {
                            if (selectedIds.size > 0) {
                              toggleSelected(attachment.id);
                              return;
                            }
                            onSelect(url);
                            onClose();
                          }
                        : undefined
                    }
                  >
                    <Box className={classes.thumbWrapper}>
                      <LoadingOverlay visible={deletingId === attachment.id} />
                      <Image src={getFileUrl(url)} radius="sm" h={100} fit="cover" />

                      <Checkbox
                        size="sm"
                        className={classes.checkbox}
                        data-visible={isSelected || undefined}
                        checked={isSelected}
                        onChange={() => toggleSelected(attachment.id)}
                        onClick={(e) => e.stopPropagation()}
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
                            if (e.key === "Escape") cancelEditing();
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
          )}
        </Tabs.Panel>

        {onSelect && pageId && (
          <Tabs.Panel value="upload" pt="md">
            <Center py="xl">
              <Button
                leftSection={<IconCloudUpload size={16} />}
                onClick={() => uploadTabInputRef.current?.click()}
              >
                {t("Upload a file")}
              </Button>
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
