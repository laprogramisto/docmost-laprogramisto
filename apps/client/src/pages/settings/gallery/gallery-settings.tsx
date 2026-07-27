import SettingsTitle from "@/components/settings/settings-title.tsx";
import { Helmet } from "react-helmet-async";
import { getAppName } from "@/lib/config.ts";
import { useTranslation } from "react-i18next";
import { Divider } from "@mantine/core";
import GalleryMaxBulkUpload from "@/features/attachments/components/settings/gallery-max-bulk-upload.tsx";
import GalleryPageSize from "@/features/attachments/components/settings/gallery-page-size.tsx";
import GalleryRateLimit from "@/features/attachments/components/settings/gallery-rate-limit.tsx";
import GalleryRestrictDelete from "@/features/attachments/components/settings/gallery-restrict-delete.tsx";

// Same assembly pattern as WorkspaceSettings (pages/settings/workspace/
// workspace-settings.tsx): independent, self-saving components separated
// by Divider, rather than one shared form state with a single page-level
// Save button.
export default function GallerySettings() {
  const { t } = useTranslation();

  return (
    <>
      <Helmet>
        <title>
          {t("Gallery")} - {getAppName()}
        </title>
      </Helmet>
      <SettingsTitle title={t("Gallery")} />

      <GalleryMaxBulkUpload />

      <Divider my="md" />
      <GalleryPageSize />

      <Divider my="md" />
      <GalleryRateLimit />

      <Divider my="md" />
      <GalleryRestrictDelete />
    </>
  );
}
