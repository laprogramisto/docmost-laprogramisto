import { useEffect, useState } from "react";
import { Group, NumberInput, Text, Button } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import {
  useGallerySettingsQuery,
  useUpdateGallerySettingsMutation,
  DEFAULT_GALLERY_SETTINGS,
} from "@/features/attachments/queries/attachment-query.ts";

export default function GalleryPageSize() {
  const { t } = useTranslation();
  const { data: gallerySettings } = useGallerySettingsQuery();
  const mutation = useUpdateGallerySettingsMutation();
  const [value, setValue] = useState<number>(
    DEFAULT_GALLERY_SETTINGS.defaultPageSize,
  );

  useEffect(() => {
    if (gallerySettings) setValue(gallerySettings.defaultPageSize);
  }, [gallerySettings]);

  const handleSave = () => {
    mutation.mutate(
      { defaultPageSize: value },
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
        <Text size="md">{t("Images per page")}</Text>
        <Text size="sm" c="dimmed">
          {t(
            "Number of images shown per page in the gallery grid before loading more.",
          )}
        </Text>
      </div>
      <Group gap="xs" wrap="nowrap">
        <NumberInput
          value={value}
          onChange={(v) => setValue(typeof v === "number" ? v : 6)}
          min={6}
          max={200}
          hideControls
          size="sm"
          w={70}
        />
        <Button
          size="sm"
          variant="default"
          onClick={handleSave}
          loading={mutation.isPending}
          disabled={gallerySettings?.defaultPageSize === value}
        >
          {t("Save")}
        </Button>
      </Group>
    </Group>
  );
}
