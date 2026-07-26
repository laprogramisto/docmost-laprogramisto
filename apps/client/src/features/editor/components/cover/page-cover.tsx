import React, { useEffect, useRef, useState } from "react";
import { Box, ActionIcon, Group, Tooltip, Button } from "@mantine/core";
import {
  IconPhoto,
  IconTrash,
  IconRefresh,
  IconArrowsMove,
  IconCheck,
  IconX,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconDownload,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useUpdatePageMutation } from "@/features/page/queries/page-query.ts";
import { getFileUrl } from "@/lib/config.ts";
import toolbarClasses from "../common/toolbar-menu.module.css";
import classes from "./page-cover.module.css";
import GalleryModal from "@/features/attachments/components/gallery-modal.tsx";

interface PageCoverProps {
  pageId: string;
  coverPhoto?: string;
  coverPhotoPosition?: number;
  coverPhotoSize?: string;
  editable: boolean;
  spaceId?: string;
}

export function PageCover({
  pageId,
  coverPhoto,
  coverPhotoPosition,
  coverPhotoSize,
  editable,
  spaceId,
}: PageCoverProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startY: number; startPosition: number } | null>(null);
  const { mutateAsync: updatePageAsync } = useUpdatePageMutation();
  const [pickerOpened, setPickerOpened] = useState(false);
  const [position, setPosition] = useState<number>(coverPhotoPosition ?? 50);
  const [isRepositioning, setIsRepositioning] = useState(false);

  useEffect(() => {
    setPosition(coverPhotoPosition ?? 50);
  }, [coverPhotoPosition]);

  useEffect(() => {
    if (!isRepositioning) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragState.current) return;
      const deltaY = e.clientY - dragState.current.startY;
      const containerHeight = containerRef.current?.clientHeight ?? 240;
      const deltaPercent = (deltaY / containerHeight) * 100;
      const next = Math.min(
        100,
        Math.max(0, dragState.current.startPosition - deltaPercent),
      );
      setPosition(next);
    };

    const handleMouseUp = () => {
      dragState.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isRepositioning]);

  const handleSelectCover = (url: string) => {
    updatePageAsync({ pageId, coverPhoto: url, coverPhotoPosition: 50 });
    setPosition(50);
  };

  const handleRemove = async () => {
    await updatePageAsync({ pageId, coverPhoto: null, coverPhotoPosition: null });
  };

  const handleDownload = async () => {
    const res = await fetch(getFileUrl(coverPhoto), { credentials: "include" });
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = coverPhoto.split("/").pop() || "cover";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  };

  const handleSavePosition = async () => {
    await updatePageAsync({ pageId, coverPhotoPosition: Math.round(position) });
    setIsRepositioning(false);
  };

  const handleCancelPosition = () => {
    setPosition(coverPhotoPosition ?? 50);
    setIsRepositioning(false);
  };

  const handleToggleSize = async () => {
    await updatePageAsync({
      pageId,
      coverPhotoSize: coverPhotoSize === "small" ? "large" : "small",
    });
  };

  if (!coverPhoto) {
    if (!editable) return null;
    return (
      <>
        <Group justify="flex-start" mb="sm">
          <Button
            variant="subtle"
            size="xs"
            color="gray"
            leftSection={<IconPhoto size={16} />}
            onClick={() => setPickerOpened(true)}
          >
            {t("Add cover")}
          </Button>
        </Group>
        <GalleryModal
          opened={pickerOpened}
          onClose={() => setPickerOpened(false)}
          spaceId={spaceId}
          pageId={pageId}
          onSelect={handleSelectCover}
        />
      </>
    );
  }

  return (
    <>
      <Box
        ref={containerRef}
        className={classes.coverWrapper}
        onMouseDown={(e) => {
          if (!isRepositioning) return;
          dragState.current = { startY: e.clientY, startPosition: position };
        }}
        style={{
          cursor: isRepositioning ? "grab" : "default",
          height: coverPhotoSize === "small" ? 120 : 240,
        }}
      >
        <img
          src={getFileUrl(coverPhoto)}
          alt=""
          className={classes.coverImage}
          style={{ objectPosition: `center ${position}%` }}
          draggable={false}
        />
        {editable && (
          <Group className={`${toolbarClasses.toolbar} ${classes.coverActions}`} gap={2}>
            {isRepositioning ? (
              <>
                <Tooltip label={t("Save position")}>
                  <ActionIcon variant="subtle" onClick={handleSavePosition}>
                    <IconCheck size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t("Cancel")}>
                  <ActionIcon variant="subtle" onClick={handleCancelPosition}>
                    <IconX size={16} />
                  </ActionIcon>
                </Tooltip>
              </>
            ) : (
              <>
                <Tooltip label={coverPhotoSize === "small" ? t("Make large") : t("Make small")}>
                  <ActionIcon variant="subtle" onClick={handleToggleSize}>
                    {coverPhotoSize === "small" ? (
                      <IconArrowsMaximize size={16} />
                    ) : (
                      <IconArrowsMinimize size={16} />
                    )}
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t("Reposition")}>
                  <ActionIcon variant="subtle" onClick={() => setIsRepositioning(true)}>
                    <IconArrowsMove size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t("Change cover")}>
                  <ActionIcon variant="subtle" onClick={() => setPickerOpened(true)}>
                    <IconRefresh size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t("Download")}>
                  <ActionIcon variant="subtle" onClick={handleDownload}>
                    <IconDownload size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t("Remove")}>
                  <ActionIcon variant="subtle" onClick={handleRemove}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Tooltip>
              </>
            )}
          </Group>
        )}
      </Box>
      <GalleryModal
        opened={pickerOpened}
        onClose={() => setPickerOpened(false)}
        spaceId={spaceId}
        pageId={pageId}
        onSelect={handleSelectCover}
      />
    </>
  );
}
