import { describe, expect, it } from "vitest";
import type { ThreadPullRequest, WorkspaceStatus } from "@bb/domain";
import { resolveThreadGitSidebarStatus } from "./threadGitSidebarStatus";

function workspace(
  state: WorkspaceStatus["workingTree"]["state"],
  aheadCount = 0,
): WorkspaceStatus {
  return {
    workingTree: {
      state,
      hasUncommittedChanges:
        state === "dirty_uncommitted" ||
        state === "dirty_and_committed_unmerged" ||
        state === "untracked",
      insertions: 0,
      deletions: 0,
      lineStatsComplete: true,
      files: [],
    },
    checkout: {
      kind: "branch",
      branchName: "feature/test",
      headSha: "def456",
    },
    branch: {
      currentBranch: "feature/test",
      defaultBranch: "main",
    },
    mergeBase: {
      mergeBaseBranch: "main",
      baseRef: "abc123",
      aheadCount,
      behindCount: 0,
      hasCommittedUnmergedChanges: aheadCount > 0,
      commits: [],
      insertions: 0,
      deletions: 0,
      lineStatsComplete: true,
      files: [],
    },
  };
}

const mergedPullRequest = {
  state: "merged",
} as ThreadPullRequest;

describe("resolveThreadGitSidebarStatus", () => {
  it("shows merged when the pull request is merged", () => {
    expect(
      resolveThreadGitSidebarStatus({
        workspace: workspace("clean"),
        pullRequest: mergedPullRequest,
      }),
    ).toBe("merged");
  });

  it.each([
    "dirty_uncommitted",
    "dirty_and_committed_unmerged",
    "untracked",
  ] as const)("shows uncommitted for %s", (state) => {
    expect(
      resolveThreadGitSidebarStatus({
        workspace: workspace(state),
        pullRequest: null,
      }),
    ).toBe("uncommitted");
  });

  it("shows unmerged for committed changes", () => {
    expect(
      resolveThreadGitSidebarStatus({
        workspace: workspace("committed_unmerged", 2),
        pullRequest: null,
      }),
    ).toBe("unmerged");
  });

  it("treats a clean branch that is still ahead as unmerged", () => {
    expect(
      resolveThreadGitSidebarStatus({
        workspace: workspace("clean", 1),
        pullRequest: null,
      }),
    ).toBe("unmerged");
  });

  it("shows clean when nothing is pending", () => {
    expect(
      resolveThreadGitSidebarStatus({
        workspace: workspace("clean"),
        pullRequest: null,
      }),
    ).toBe("clean");
  });

  it("does not guess when workspace state is unavailable", () => {
    expect(
      resolveThreadGitSidebarStatus({
        workspace: null,
        pullRequest: null,
      }),
    ).toBeNull();
  });
});
