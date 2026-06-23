/**
 * A strictly read-only view of a {@link GitHubRepositoryPort}.
 *
 * Dry-run mode must perform no comments, labels, assignments, or issue updates.
 * Wrapping the repository so every mutating method is an inert no-op guarantees
 * the zero-write invariant by construction: even code paths that forget an
 * explicit dry-run guard cannot mutate the repository through this view. Read
 * methods delegate unchanged.
 */

import type { GitHubRepositoryPort } from '../ports/github-repository.js';

/**
 * Wrap a repository port so all writes become no-ops while reads pass through.
 */
export function readOnlyRepository(
  repository: GitHubRepositoryPort,
): GitHubRepositoryPort {
  return {
    // Reads delegate directly.
    getRepositoryInfo: () => repository.getRepositoryInfo(),
    getDefaultBranchFile: (path) => repository.getDefaultBranchFile(path),
    branchExists: (branch) => repository.branchExists(branch),
    getRepositoryLabelNames: () => repository.getRepositoryLabelNames(),
    hasWriteAccess: () => repository.hasWriteAccess(),
    getEpic: (epicNumber) => repository.getEpic(epicNumber),
    getEpicWithSubIssues: (epicNumber, numbers) =>
      repository.getEpicWithSubIssues(epicNumber, numbers),
    getNativeSubIssueNumbers: (epicNumber) =>
      repository.getNativeSubIssueNumbers(epicNumber),
    getParentEpicNumber: (issueNumber) =>
      repository.getParentEpicNumber(issueNumber),
    getMarkdownSubIssueNumbers: (epicNumber, heading) =>
      repository.getMarkdownSubIssueNumbers(epicNumber, heading),
    getCanonicalStateLabels: (issueNumber, canonicalLabels) =>
      repository.getCanonicalStateLabels(issueNumber, canonicalLabels),
    getPullRequestCompletion: (pullRequestNumber) =>
      repository.getPullRequestCompletion(pullRequestNumber),
    getMergedPullRequest: (pullRequestNumber) =>
      repository.getMergedPullRequest(pullRequestNumber),
    getOpenedPullRequest: (pullRequestNumber) =>
      repository.getOpenedPullRequest(pullRequestNumber),
    findActiveSubIssues: (inProgressLabel) =>
      repository.findActiveSubIssues(inProgressLabel),
    getLinkedPullRequestNumbers: (issueNumber) =>
      repository.getLinkedPullRequestNumbers(issueNumber),
    getStatusComment: (issueNumber, marker) =>
      repository.getStatusComment(issueNumber, marker),

    // Writes are inert no-ops in dry-run mode.
    setCanonicalState: async () => undefined,
    closeIssueAsCompleted: async () => undefined,
    updatePullRequestBody: async () => undefined,
    createLabel: async () => undefined,
    upsertStatusComment: async () => undefined,
  };
}
