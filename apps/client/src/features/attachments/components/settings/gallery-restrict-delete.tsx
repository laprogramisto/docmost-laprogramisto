import { useEffect, useState } from "react";
import { Group, Switch, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import {
  useGallerySettingsQuery,
  useUpdateGallerySettingsMutation,
  DEFAULT_GALLERY_SETTINGS,
} from "@/features/attachments/queries/attachment-query.ts";

// Same immediate-commit pattern as AllowMemberTemplates and
// WorkspaceDefaultPageEditMode — a Switch saves on toggle, with a silent
// rollback to the previous value on failure, rather than requiring a
// separate Save action the way the NumberInput settings above do.
export default function GalleryRestrictDelete() {
  const { t } = useTranslation();
  const { data: gallerySettings } = useGallerySettingsQuery();
  const mutation = useUpdateGallerySettingsMutation();
  const [checked, setChecked] = useState<boolean>(
    DEFAULT_GALLERY_SETTINGS.restrictDeleteToOwners,
  );

  useEffect(() => {
    if (gallerySettings) setChecked(gallerySettings.restrictDeleteToOwners);
  }, [gallerySettings]);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    const previous = checked;
    setChecked(value);

    mutation.mutate(
      { restrictDeleteToOwners: value },
      {
        onError: () => {
          setChecked(previous);
          notifications.show({
            color: "red",
            message: t("Failed to update data"),
          });
        },
      },
    );
  };

  return (
    <Group justify="space-between" wrap="nowrap" gap="xl">
      <div>
        <Text size="md">{t("Restrict gallery deletion to owners")}</Text>
        <Text size="sm" c="dimmed">
          {t(
            "When enabled, only workspace owners can delete images from the shared gallery. When disabled, anyone with edit rights in the relevant space can.",
          )}
        </Text>
      </div>
      <Switch checked={checked} onChange={handleChange} />
    </Group>
  );
}
