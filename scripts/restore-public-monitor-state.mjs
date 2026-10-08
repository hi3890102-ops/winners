// Used by actions/github-script with actions:read. All API calls are GETs.
export const CHECKPOINT_PREFIX = 'public-monitor-state-v1-';
const artifactPattern = /^public-monitor-state-v1-(\d+)-(\d+)$/;
const trustedEvents = new Set(['schedule', 'push', 'workflow_dispatch']);

export async function findPreviousCheckpoint({ github, owner, repo, runId, attempt, branch, initialize = false }) {
  const { data: current } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
  const trusted = run => run.workflow_id === current.workflow_id && run.head_branch === branch
    && run.head_repository?.id === current.repository.id && run.repository?.id === current.repository.id
    && trustedEvents.has(run.event) && run.path === '.github/workflows/monitor-public.yml';
  if (!trusted(current)) throw new Error('Incident state is restricted to the default-branch public monitor');
  const runs = new Map([[String(runId), current]]);
  // GitHub lists repository artifacts newest first. Artifact IDs, not run IDs,
  // select commit order: a rerun of an old run can be the newest checkpoint.
  for (let page = 1; ; page++) {
    const { data } = await github.rest.actions.listArtifactsForRepo({ owner, repo, per_page: 100, page });
    for (const artifact of [...data.artifacts].sort((a, b) => b.id - a.id)) {
      const match = artifact.name.match(artifactPattern);
      if (!match || String(artifact.workflow_run?.id) !== match[1]) continue;
      const sourceId = match[1];
      const sourceAttempt = Number(match[2]);
      if (sourceId === String(runId) && sourceAttempt >= attempt) continue;
      if (artifact.workflow_run.head_branch !== branch || artifact.workflow_run.head_repository_id !== current.repository.id) continue;
      if (!runs.has(sourceId)) {
        const { data: source } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: sourceId });
        runs.set(sourceId, source);
      }
      const source = runs.get(sourceId);
      if (!trusted(source) || sourceAttempt > source.run_attempt) continue;
      // Failed outage runs are valid sources. Never fall back past an expired
      // or unreadable newest checkpoint to a stale state that could re-alert.
      if (artifact.expired) throw new Error('Latest incident checkpoint expired; restore history before resuming alerts');
      return { mode: 'restored', artifactId: String(artifact.id), runId: sourceId, attempt: sourceAttempt };
    }
    if (data.artifacts.length < 100) break;
  }
  if (initialize && current.event === 'workflow_dispatch') return { mode: 'initialized' };
  throw new Error('No incident checkpoint. For first use only, manually dispatch with initialize_state=true; otherwise restore lost history');
}
