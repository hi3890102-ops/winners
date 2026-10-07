// Incident state machine. No network, credentials, business data or notification delivery.
import { createHash } from 'node:crypto';

export const STATE_VERSION = 1;
export const STATE_SCOPE = 'public-assets-v1';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
function requireState(condition, message) {
  if (!condition) throw new Error(`Invalid monitor state: ${message}`);
}

export function targetIdentity(origin, path) {
  const base = new URL(origin);
  const url = new URL(path, base);
  requireState(base.protocol === 'https:' && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password, 'site origin');
  requireState(path.startsWith('/') && !path.startsWith('//') && url.origin === base.origin, 'resource path');
  // Query strings and fragments are not resource identities for these static-asset checks.
  return { origin: base.origin, path: url.pathname };
}

export function incidentKey(origin, path, reason) {
  requireState(typeof reason === 'string' && /^[a-z0-9][a-z0-9:_-]*$/.test(reason), 'failure reason');
  const target = targetIdentity(origin, path);
  return `public-v1-${hash([target.origin, target.path, reason])}`;
}

export function normalizeFailure(error) {
  if (error?.monitorReason) return error.monitorReason;
  const code = error?.cause?.code ?? error?.code;
  if (error?.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return 'network:timeout';
  if (error?.name === 'AbortError') return 'network:aborted';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'network:dns';
  if (code === 'ECONNREFUSED') return 'network:refused';
  if (['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) return 'network:connection';
  if (/CERT|TLS|SSL/.test(code ?? '')) return 'network:tls';
  if (/unexpected redirect/i.test(error?.cause?.message ?? '')) return 'network:redirect';
  // Never fingerprint runtime prose (IPs, durations, line numbers, request IDs).
  return 'network:other';
}

export function createIncidentState(seed) {
  requireState(typeof seed === 'string' && seed.length > 0, 'initialization seed');
  return { schemaVersion: STATE_VERSION, scope: STATE_SCOPE, lineage: hash(seed), generation: 0, checkedAt: null, run: null, incidents: {} };
}

const occurrenceId = (key, lineage, occurrence) => `${key}:${lineage}:${occurrence}`;

export function validateIncidentState(state, expectedRun) {
  requireState(state?.schemaVersion === STATE_VERSION && state.scope === STATE_SCOPE, 'schema or scope');
  requireState(/^[a-f0-9]{64}$/.test(state.lineage ?? ''), 'lineage');
  requireState(positiveInteger(state.generation) && timestamp(state.checkedAt), 'generation or checkedAt');
  requireState(state.run && typeof state.run.id === 'string' && positiveInteger(state.run.attempt), 'source run');
  if (expectedRun) requireState(state.run.id === expectedRun.id && state.run.attempt === expectedRun.attempt, 'artifact/run binding');
  requireState(state.incidents && typeof state.incidents === 'object' && !Array.isArray(state.incidents), 'incidents');
  for (const [key, incident] of Object.entries(state.incidents)) {
    requireState(key === incident.key && key === incidentKey(incident.origin, incident.path, incident.reason), 'incident key');
    requireState(['open', 'resolved'].includes(incident.status), 'incident status');
    requireState(positiveInteger(incident.occurrence) && Number.isSafeInteger(incident.consecutiveFailures) && incident.consecutiveFailures >= 0, 'incident counters');
    requireState(incident.id === occurrenceId(key, state.lineage, incident.occurrence), 'incident ID');
    requireState(timestamp(incident.firstSeenAt) && timestamp(incident.openedAt) && timestamp(incident.lastSeenAt), 'incident timestamps');
    requireState(incident.firstSeenAt <= incident.openedAt && incident.openedAt <= incident.lastSeenAt && incident.lastSeenAt <= state.checkedAt, 'incident chronology');
    requireState(incident.status === 'open' ? incident.recoveredAt === null : timestamp(incident.recoveredAt) && incident.lastSeenAt <= incident.recoveredAt && incident.recoveredAt <= state.checkedAt, 'recovery timestamp');
  }
  return state;
}

export function advanceIncidents(previous, sites, checkedAt, run) {
  if (previous.generation !== 0) validateIncidentState(previous);
  requireState(timestamp(checkedAt) && (!previous.checkedAt || checkedAt >= previous.checkedAt), 'check chronology');
  const state = structuredClone(previous);
  state.generation++;
  state.checkedAt = checkedAt;
  state.run = run;
  const observations = new Map();
  const transitions = [];
  const addTransition = (incident, transition, observed = true) => {
    const shouldNotify = ['new', 'recurred', 'recovered'].includes(transition);
    transitions.push({ ...incident, transition, observed, shouldNotify,
      eventId: shouldNotify ? `${incident.id}:${transition === 'recovered' ? 'recovered' : 'opened'}` : null });
  };
  for (const site of sites) for (const check of site.checks) {
    const target = targetIdentity(site.origin, check.path);
    const targetKey = JSON.stringify(target);
    requireState(!observations.has(targetKey), 'duplicate resource');
    requireState(typeof check.ok === 'boolean', 'check outcome');
    observations.set(targetKey, check);
    if (check.ok) continue;
    const key = incidentKey(target.origin, target.path, check.failureReason);
    const old = state.incidents[key];
    const continuing = old?.status === 'open';
    const occurrence = continuing ? old.occurrence : (old?.occurrence ?? 0) + 1;
    const incident = {
      key, id: occurrenceId(key, state.lineage, occurrence), ...target, site: site.name,
      reason: check.failureReason, status: 'open', occurrence,
      firstSeenAt: old?.firstSeenAt ?? checkedAt,
      openedAt: continuing ? old.openedAt : checkedAt, lastSeenAt: checkedAt, recoveredAt: null,
      consecutiveFailures: continuing ? old.consecutiveFailures + 1 : 1,
    };
    state.incidents[key] = incident;
    addTransition(incident, continuing ? 'ongoing' : old ? 'recurred' : 'new');
    check.incidentKey = key;
    check.incidentId = incident.id;
  }
  const observedKeys = new Set(transitions.map(incident => incident.key));
  for (const incident of Object.values(state.incidents)) {
    if (incident.status !== 'open' || observedKeys.has(incident.key)) continue;
    const check = observations.get(JSON.stringify({ origin: incident.origin, path: incident.path }));
    // Missing/removed checks or a different failure do not prove recovery.
    if (check?.ok === true) {
      incident.status = 'resolved';
      incident.recoveredAt = checkedAt;
      addTransition(incident, 'recovered');
    } else {
      incident.consecutiveFailures = 0;
      addTransition(incident, 'unobserved', false);
    }
  }
  transitions.sort((a, b) => a.key.localeCompare(b.key));
  validateIncidentState(state);
  return { state, incidents: transitions, notifications: transitions.filter(incident => incident.shouldNotify) };
}

// Called only after the state and result were committed together as one artifact.
export function committedAlertExitCode(report, checkpointSaved) {
  if (!checkpointSaved || !['initialized', 'restored'].includes(report.incidentTracking?.status)) return 1;
  return report.notifications.some(event => ['new', 'recurred'].includes(event.transition)) ? 1 : 0;
}
