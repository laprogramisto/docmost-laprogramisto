import { useQuery } from "@tanstack/react-query";
import { getWorkspaceImages } from "@/features/attachments/services";

export function useWorkspaceImagesQuery() {
  return useQuery({
    queryKey: ["workspace-images"],
    queryFn: () => getWorkspaceImages({ limit: 60 }),
    refetchOnMount: "always",
  });
}