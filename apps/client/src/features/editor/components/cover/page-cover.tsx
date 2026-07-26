import React, { useEffect, useRef, useState } from "react";
import { Box, ActionIcon, Group, Tooltip, Button } from "@mantine/core";
import {
  IconPhoto,
  IconTrash,
  IconRefresh,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconDownload,
  IconCheck,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useUpdatePageMutation } from "@/features/page/queries/page-query.ts";
import { getFileUrl } from "@/lib/config.ts";
import toolbarClasses from "../common/toolbar-menu.module.css";
import classes from "./page-cover.module.css";
import GalleryModal from "@/features/attachments/components/gallery-modal.tsx";

// Below this many pixels of movement, a mousedown+mouseup is treated as a
// plain click (do nothing) rather than the start of a drag-to-reposition
// gesture — avoids entering reposition mode on an accidental click.
const DRAG_THRESHOLD_PX = 4;

interface PageCoverProps {
  pageId: string;
  coverPhoto?: string;
  coverPhotoPosition?: number;
  coverPhotoPositionX?: number;
  coverPhotoSize?: string;
  editable: boolean;
  spaceId?: string;
}

export function PageCover({
  pageId,
  coverPhoto,
  coverPhotoPosition,
  coverPhotoPositionX,
  coverPhotoSize,
  editable,
  spaceId,
}: PageCoverProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const { mutateAsync: updatePageAsync } = useUpdatePageMutation();
  const [pickerOpened, setPickerOpened] = useState(false);

  const [position, setPosition] = useState<number>(coverPhotoPosition ?? 50);
  const [positionX, setPositionX] = useState<number>(coverPhotoPositionX ?? 50);
  const [isRepositioning, setIsRepositioning] = useState(false);

  // Tracks an in-progress mousedown, before we know yet whether it'll turn
  // into a drag (reposition) or stay a plain click.
  const dragState = useRef<{
    startX: number;
    startY: number;
    startPosition: number;
    startPositionX: number;
    hasMoved: boolean;
  } | null>(null);

  useEffect(() => {
    setPosition(coverPhotoPosition ?? 50);
  }, [coverPhotoPosition]);

  useEffect(() => {
    setPositionX(coverPhotoPositionX ?? 50);
  }, [coverPhotoPositionX]);

  useEffect(() => {
    if (!editable) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragState.current) return;
      const deltaX = e.clientX - dragState.current.startX;
      const deltaY = e.clientY - dragState.current.startY;

      if (
        !dragState.current.hasMoved &&
        Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX
      ) {
        return;
      }

      if (!dragState.current.hasMoved) {
        dragState.current.hasMoved = true;
        setIsRepositioning(true);
      }

      const containerHeight = containerRef.current?.clientHeight ?? 240;
      const containerWidth = containerRef.current?.clientWidth ?? 1;

      const nextY = Math.min(
        100,
        Math.max(0, dragState.current.startPosition - (deltaY / containerHeight) * 100),
      );
      const nextX = Math.min(
        100,
        Math.max(0, dragState.current.startPositionX - (deltaX / containerWidth) * 100),
      );

      setPosition(nextY);
      setPositionX(nextX);
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
  }, [editable]);

  const handleImageMouseDown = (e: React.MouseEvent) => {
    if (!editable || isRepositioning) return;
    // Only the left mouse button starts a potential drag.
    if (e.button !== 0) return;

    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPosition: position,
      startPositionX: positionX,
      hasMoved: false,
    };
  };

  const handleSelectCover = (url: string) => {
    updatePageAsync({
      pageId,
      coverPhoto: url,
      coverPhotoPosition: 50,
      coverPhotoPositionX: 50,
    });
    setPosition(50);
    setPositionX(50);
  };

  const handleRemove = async () => {
    await updatePageAsync({
      pageId,
      coverPhoto: null,
      coverPhotoPosition: null,
      coverPhotoPositionX: null,
    });
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
    await updatePageAsync({
      pageId,
      coverPhotoPosition: Math.round(position),
      coverPhotoPositionX: Math.round(positionX),
    });
    setIsRepositioning(false);
  };

  const handleCancelPosition = () => {
    setPosition(coverPhotoPosition ?? 50);
    setPositionX(coverPhotoPositionX ?? 50);
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
        style={{
          height: coverPhotoSize === "small" ? 120 : 240,
        }}
      >
        <img
          src={getFileUrl(coverPhoto)}
          alt=""
          className={classes.coverImage}
          style={{
            objectPosition: `${positionX}% ${position}%`,
            cursor: editable ? "grab" : "default",
          }}
          draggable={false}
          onMouseDown={handleImageMouseDown}
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
