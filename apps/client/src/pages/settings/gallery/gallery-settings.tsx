import SettingsTitle from "@/components/settings/settings-title.tsx";
import { Helmet } from "react-helmet-async";
import { getAppName } from "@/lib/config.ts";
import { useTranslation } from "react-i18next";
import { Button, Group, NumberInput, Stack, Switch, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useState } from "react";
import {
  useGallerySettingsQuery,
  useUpdateGallerySettingsMutation,
  DEFAULT_GALLERY_SETTINGS,
} from "@/features/attachments/queries/attachment-query.ts";

// Row layout follows the rest of the Settings area's inline convention —
// label + description on the left, a compact control on the right (see
// AllowMemberTemplates / TrashRetention) — rather than a label stacked
// above a full-width input.
function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="xl">
      <div>
        <Text size="md">{label}</Text>
        <Text size="sm" c="dimmed">
          {description}
        </Text>
      </div>
      {children}
    </Group>
  );
}

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
  const [restrictDeleteToOwners, setRestrictDeleteToOwners] =
    useState<boolean>(DEFAULT_GALLERY_SETTINGS.restrictDeleteToOwners);

  // This page replaces the old settings popover in the Gallery modal,
  // which re-seeded its draft fields every time it opened. There's no
  // equivalent "open" event on a standalone page, so syncing whenever the
  // query resolves (or refetches) is the closest equivalent.
  useEffect(() => {
    if (!gallerySettings) return;
    setMaxBulkUploadFiles(gallerySettings.maxBulkUploadFiles);
    setDefaultPageSize(gallerySettings.defaultPageSize);
    setRateLimitPerMinute(gallerySettings.rateLimitPerMinute);
    setRestrictDeleteToOwners(gallerySettings.restrictDeleteToOwners);
  }, [gallerySettings]);

  const handleSave = () => {
    updateGallerySettingsMutation.mutate(
      {
        maxBulkUploadFiles,
        defaultPageSize,
        rateLimitPerMinute,
        restrictDeleteToOwners,
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
      <SettingsTitle title={t("Gallery")} />

      <Stack gap="lg" maw={520}>
        <SettingRow
          label={t("Max files per bulk upload")}
          description={t(
            "Limits how many images can be selected at once when bulk-uploading to the shared gallery.",
          )}
        >
          <NumberInput
            w={90}
            size="sm"
            hideControls={false}
            min={1}
            max={500}
            value={maxBulkUploadFiles}
            onChange={(v) =>
              setMaxBulkUploadFiles(typeof v === "number" ? v : 1)
            }
          />
        </SettingRow>

        <SettingRow
          label={t("Images per page")}
          description={t(
            "Number of images shown per page in the gallery grid before loading more.",
          )}
        >
          <NumberInput
            w={90}
            size="sm"
            min={6}
            max={200}
            value={defaultPageSize}
            onChange={(v) =>
              setDefaultPageSize(typeof v === "number" ? v : 6)
            }
          />
        </SettingRow>

        <SettingRow
          label={t("Requests per minute")}
          description={t(
            "Rate limit applied to gallery uploads, listing, and management actions, per user.",
          )}
        >
          <NumberInput
            w={90}
            size="sm"
            min={10}
            max={1000}
            value={rateLimitPerMinute}
            onChange={(v) =>
              setRateLimitPerMinute(typeof v === "number" ? v : 10)
            }
          />
        </SettingRow>

        <SettingRow
          label={t("Restrict gallery deletion to owners")}
          description={t(
            "When enabled, only workspace owners can delete images from the shared gallery. When disabled, anyone with edit rights in the relevant space can.",
          )}
        >
          <Switch
            checked={restrictDeleteToOwners}
            onChange={(e) =>
              setRestrictDeleteToOwners(e.currentTarget.checked)
            }
          />
        </SettingRow>

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
