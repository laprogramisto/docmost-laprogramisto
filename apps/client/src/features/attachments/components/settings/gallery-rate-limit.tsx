import { useEffect, useState } from "react";
import { Group, NumberInput, Text, Button } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import {
  useGallerySettingsQuery,
  useUpdateGallerySettingsMutation,
  DEFAULT_GALLERY_SETTINGS,
} from "@/features/attachments/queries/attachment-query.ts";

export default function GalleryRateLimit() {
  const { t } = useTranslation();
  const { data: gallerySettings } = useGallerySettingsQuery();
  const mutation = useUpdateGallerySettingsMutation();
  const [value, setValue] = useState<number>(
    DEFAULT_GALLERY_SETTINGS.rateLimitPerMinute,
  );

  useEffect(() => {
    if (gallerySettings) setValue(gallerySettings.rateLimitPerMinute);
  }, [gallerySettings]);

  const handleSave = () => {
    mutation.mutate(
      { rateLimitPerMinute: value },
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
        <Text size="md">{t("Requests per minute")}</Text>
        <Text size="sm" c="dimmed">
          {t(
            "Rate limit applied to gallery uploads, listing, and management actions, per user.",
          )}
        </Text>
      </div>
      <Group gap="xs" wrap="nowrap">
        <NumberInput
          value={value}
          onChange={(v) => setValue(typeof v === "number" ? v : 10)}
          min={10}
          max={1000}
          hideControls
          size="sm"
          w={70}
        />
        <Button
          size="sm"
          variant="default"
          onClick={handleSave}
          loading={mutation.isPending}
          disabled={gallerySettings?.rateLimitPerMinute === value}
        >
          {t("Save")}
        </Button>
      </Group>
    </Group>
  );
}
