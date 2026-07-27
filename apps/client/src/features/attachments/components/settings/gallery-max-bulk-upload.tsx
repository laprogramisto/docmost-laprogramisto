import { useEffect, useState } from "react";
import { Group, NumberInput, Text, Button } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import {
  useGallerySettingsQuery,
  useUpdateGallerySettingsMutation,
  DEFAULT_GALLERY_SETTINGS,
} from "@/features/attachments/queries/attachment-query.ts";

// Same shape as TrashRetention (ee/security/components/trash-retention.tsx):
// a NumberInput only commits on its own Save button, not on every
// keystroke — unlike a Switch/SegmentedControl, typing a number one digit
// at a time shouldn't fire a request per keystroke.
export default function GalleryMaxBulkUpload() {
  const { t } = useTranslation();
  const { data: gallerySettings } = useGallerySettingsQuery();
  const mutation = useUpdateGallerySettingsMutation();
  const [value, setValue] = useState<number>(
    DEFAULT_GALLERY_SETTINGS.maxBulkUploadFiles,
  );

  useEffect(() => {
    if (gallerySettings) setValue(gallerySettings.maxBulkUploadFiles);
  }, [gallerySettings]);

  const handleSave = () => {
    mutation.mutate(
      { maxBulkUploadFiles: value },
      {
        onSuccess: () => notifications.show({ message: t("Updated successfully") }),
        onError: () =>
          notifications.show({ color: "red", message: t("Failed to update data") }),
      },
    );
  };

  return (
    <Group justify="space-between" wrap="nowrap" gap="xl">
      <div>
        <Text size="md">{t("Max files per bulk upload")}</Text>
        <Text size="sm" c="dimmed">
          {t(
            "Limits how many images can be selected at once when bulk-uploading to the shared gallery.",
          )}
        </Text>
      </div>
      <Group gap="xs" wrap="nowrap">
        <NumberInput
          value={value}
          onChange={(v) => setValue(typeof v === "number" ? v : 1)}
          min={1}
          max={500}
          hideControls
          size="sm"
          w={70}
        />
        <Button
          size="sm"
          variant="default"
          onClick={handleSave}
          loading={mutation.isPending}
          disabled={gallerySettings?.maxBulkUploadFiles === value}
        >
          {t("Save")}
        </Button>
      </Group>
    </Group>
  );
}
