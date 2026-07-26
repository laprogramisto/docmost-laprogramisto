import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getGallerySettings,
  getWorkspaceImages,
  updateGallerySettings,
} from "@/features/attachments/services";

// Falls back to the values that were previously hardcoded (MAX_BULK_FILES in
// gallery-modal.tsx, limit: 60 here) so behavior is unchanged until an admin
// actually configures something.
export const DEFAULT_GALLERY_SETTINGS = {
  maxBulkUploadFiles: 100,
  defaultPageSize: 60,
  rateLimitPerMinute: 150,
  restrictDeleteToOwners: false,
};

export function useGallerySettingsQuery() {
  return useQuery({
    queryKey: ["gallery-settings"],
    queryFn: getGallerySettings,
    // These change rarely (an admin toggling a config screen), not on every
    // page load — no need to refetch aggressively.
    staleTime: 5 * 60 * 1000,
  });
}

export function useUpdateGallerySettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateGallerySettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gallery-settings"] });
    },
  });
}

export function useWorkspaceImagesQuery(pageSize?: number, query?: string) {
  return useInfiniteQuery({
    queryKey: ["workspace-images", query ?? ""],
    queryFn: ({ pageParam }) =>
      getWorkspaceImages({
        cursor: pageParam,
        limit: pageSize ?? DEFAULT_GALLERY_SETTINGS.defaultPageSize,
        query,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.meta.hasNextPage ? lastPage.meta.nextCursor : undefined,
    refetchOnMount: "always",
  });
}
