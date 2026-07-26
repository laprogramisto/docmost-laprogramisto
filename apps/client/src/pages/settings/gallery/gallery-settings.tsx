import SettingsTitle from "@/components/settings/settings-title.tsx";
import { Helmet } from "react-helmet-async";
import { getAppName } from "@/lib/config.ts";
import { useTranslation } from "react-i18next";
import { Button, Group, NumberInput, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useState } from "react";
import {
  useGallerySettingsQuery,
  useUpdateGallerySettingsMutation,
  DEFAULT_GALLERY_SETTINGS,
} from "@/features/attachments/queries/attachment-query.ts";

export default function GallerySettings() {
  const { t } = useTranslation();
  const { data: gallerySettings } = useGallerySettingsQuery();
  const updateGallerySettingsMutation = useUpdateGallerySettingsMutation();

  const [maxBulkUploadFiles, setMaxBulkUploadFiles] = useState<number>(
    DEFAULT_GALLERY_SETTINGS.maxBulkUploadFiles,
  );
  const [defaultPageSize, setDefaultPageSize] = useState<number>(
    DEFAULT_GALLERY_SETTINGS.defaultPageSize,
  );
  const [rateLimitPerMinute, setRateLimitPerMinute] = useState<number>(
    DEFAULT_GALLERY_SETTINGS.rateLimitPerMinute,
  );

  // This page replaces the old settings popover in the Gallery modal,
  // which re-seeded its draft fields every time it opened. There's no
  // equivalent "open" event on a standalone page, so syncing whenever the
  // query resolves (or refetches) is the closest equivalent.
  useEffect(() => {
    if (!gallerySettings) return;
    setMaxBulkUploadFiles(gallerySettings.maxBulkUploadFiles);
    setDefaultPageSize(gallerySettings.defaultPageSize);
    setRateLimitPerMinute(gallerySettings.rateLimitPerMinute);
  }, [gallerySettings]);

  const handleSave = () => {
    updateGallerySettingsMutation.mutate(
      {
        maxBulkUploadFiles,
        defaultPageSize,
        rateLimitPerMinute,
      },
      {
        onSuccess: () => {
          notifications.show({ message: t("Gallery settings saved") });
        },
        onError: () => {
          notifications.show({
            color: "red",
            message: t("Failed to update gallery settings"),
          });
        },
      },
    );
  };

  return (
    <>
      <Helmet>
        <title>
          {t("Gallery")} - {getAppName()}
        </title>
      </Helmet>
      <SettingsTitle title={t("Gallery settings")} />

      <Stack gap="lg" maw={420}>
        <div>
          <Text size="sm" fw={500}>
            {t("Max files per bulk upload")}
          </Text>
          <NumberInput
            mt={4}
            min={1}
            max={500}
            value={maxBulkUploadFiles}
            onChange={(v) =>
              setMaxBulkUploadFiles(typeof v === "number" ? v : 1)
            }
          />
        </div>

        <div>
          <Text size="sm" fw={500}>
            {t("Images per page")}
          </Text>
          <NumberInput
            mt={4}
            min={6}
            max={200}
            value={defaultPageSize}
            onChange={(v) =>
              setDefaultPageSize(typeof v === "number" ? v : 6)
            }
          />
        </div>

        <div>
          <Text size="sm" fw={500}>
            {t("Requests per minute")}
          </Text>
          <NumberInput
            mt={4}
            min={10}
            max={1000}
            value={rateLimitPerMinute}
            onChange={(v) =>
              setRateLimitPerMinute(typeof v === "number" ? v : 10)
            }
          />
        </div>

        <Group justify="flex-end">
          <Button
            onClick={handleSave}
            loading={updateGallerySettingsMutation.isPending}
          >
            {t("Save")}
          </Button>
        </Group>
      </Stack>
    </>
  );
}
