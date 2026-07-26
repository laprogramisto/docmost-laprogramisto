import { useInfiniteQuery } from "@tanstack/react-query";
import { getWorkspaceImages } from "@/features/attachments/services";

export function useWorkspaceImagesQuery() {
  return useInfiniteQuery({
    queryKey: ["workspace-images"],
    queryFn: ({ pageParam }) => getWorkspaceImages({ cursor: pageParam, limit: 60 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.meta.hasNextPage ? lastPage.meta.nextCursor : undefined,
    refetchOnMount: "always",
  });
}
