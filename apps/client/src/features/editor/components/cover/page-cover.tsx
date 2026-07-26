import React, { useEffect, useRef, useState } from "react";
import { Box, ActionIcon, Group, Tooltip, Button, Popover, TextInput } from "@mantine/core";
import {
  IconPhoto,
  IconTrash,
  IconRefresh,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconDownload,
  IconCheck,
  IconX,
  IconAccessible,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { useUpdatePageMutation } from "@/features/page/queries/page-query.ts";
import { getFileUrl } from "@/lib/config.ts";
import { downloadFile } from "@/lib/download-file.ts";
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
  coverPhotoAlt?: string;
  editable: boolean;
  spaceId?: string;
}

export function PageCover({
  pageId,
  coverPhoto,
  coverPhotoPosition,
  coverPhotoPositionX,
  coverPhotoSize,
  coverPhotoAlt,
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
  const [altPopoverOpened, setAltPopoverOpened] = useState(false);
  const [altValue, setAltValue] = useState(coverPhotoAlt ?? "");

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
    setAltValue(coverPhotoAlt ?? "");
  }, [coverPhotoAlt]);

  useEffect(() => {
    if (!editable) return;

    const handlePointerMove = (e: PointerEvent) => {
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

    const handlePointerUp = () => {
      dragState.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    // pointercancel fires when the browser interrupts the gesture (e.g. it
    // decides mid-drag that the touch is actually a page scroll) — without
    // handling it the same as pointerup, dragState could get stuck as if a
    // drag were still in progress.
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [editable]);

  const handleImagePointerDown = (e: React.PointerEvent) => {
    if (!editable) return;
    // Mouse: only the primary (left) button starts a potential drag.
    // Touch/pen have no meaningful "button" value — isPrimary marks the
    // first active contact point instead.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!e.isPrimary) return;

    // Keeps this element as the event target for the rest of the gesture
    // even if the finger/cursor moves outside its bounds mid-drag — without
    // this, a fast touch drag can lose pointermove events partway through.
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

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
    try {
      await downloadFile(
        getFileUrl(coverPhoto),
        coverPhoto.split("/").pop() || "cover",
      );
    } catch {
      notifications.show({
        color: "red",
        message: t("Failed to download image"),
      });
    }
  };

  const handleSaveAlt = async () => {
    await updatePageAsync({ pageId, coverPhotoAlt: altValue.trim() || null });
    setAltPopoverOpened(false);
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

  // Kept in a ref rather than in the effect's dependency array below:
  // position/positionX change on every mousemove frame during a drag, and
  // handleSavePosition/handleCancelPosition close over them — putting them
  // directly in the deps would tear down and re-add the keydown listener on
  // every frame instead of once per reposition session.
  const positionHandlersRef = useRef({ handleSavePosition, handleCancelPosition });
  positionHandlersRef.current = { handleSavePosition, handleCancelPosition };

  // Escape cancels the in-progress reposition (reverts to the last saved
  // position), Enter confirms it (same pair of actions as the ✓/✗ buttons
  // in the toolbar). Scoped to isRepositioning so it never intercepts
  // Escape/Enter elsewhere on the page — e.g. the alt-text popover has its
  // own independent Escape/Enter handling on its own input.
  useEffect(() => {
    if (!isRepositioning) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        positionHandlersRef.current.handleCancelPosition();
      } else if (e.key === "Enter") {
        e.preventDefault();
        positionHandlersRef.current.handleSavePosition();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isRepositioning]);

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
          alt={coverPhotoAlt ?? ""}
          className={classes.coverImage}
          style={{
            objectPosition: `${positionX}% ${position}%`,
            cursor: editable ? "grab" : "default",
            touchAction: editable ? "none" : undefined,
          }}
          draggable={false}
          onPointerDown={handleImagePointerDown}
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
                <Popover
                  opened={altPopoverOpened}
                  onChange={setAltPopoverOpened}
                  withArrow
                  position="top"
                >
                  <Popover.Target>
                    <Tooltip label={t("Alt text")}>
                      <ActionIcon
                        variant="subtle"
                        onClick={() => setAltPopoverOpened((o) => !o)}
                      >
                        <IconAccessible size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Popover.Target>
                  <Popover.Dropdown>
                    <TextInput
                      size="xs"
                      w={260}
                      placeholder={t("Describe this image")}
                      value={altValue}
                      onChange={(e) => setAltValue(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSaveAlt();
                        if (e.key === "Escape") setAltPopoverOpened(false);
                      }}
                      rightSection={
                        <ActionIcon size="sm" variant="subtle" onClick={handleSaveAlt}>
                          <IconCheck size={14} />
                        </ActionIcon>
                      }
                    />
                  </Popover.Dropdown>
                </Popover>
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
