import type { ThreadPullRequest, WorkspaceStatus } from "@bb/domain";

export type ThreadGitSidebarStatus =
  | "clean"
  | "uncommitted"
  | "unmerged"
  | "merged";

export function resolveThreadGitSidebarStatus(args: {
  workspace: WorkspaceStatus | null;
  pullRequest: ThreadPullRequest | null;
}): ThreadGitSidebarStatus | null {
  if (args.pullRequest?.state === "merged") {
    return "merged";
  }

  const workspace = args.workspace;
  if (workspace === null) {
    return null;
  }

  switch (workspace.workingTree.state) {
    case "dirty_uncommitted":
    case "dirty_and_committed_unmerged":
    case "untracked":
      return "uncommitted";
    case "committed_unmerged":
      return "unmerged";
    case "clean":
      return (workspace.mergeBase?.aheadCount ?? 0) > 0
        ? "unmerged"
        : "clean";
  }
}
