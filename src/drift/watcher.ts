/**
 * Drift watcher — the moat.
 *
 * Buffer's ContentItem API is Experimental: shapes may change
 * non-backwards-compatibly. This watcher runs on the Worker's cron
 * trigger and diffs Buffer's live surface against the pinned snapshot in
 * this repo (contentitem-snapshot.json). Differences raise a Discord
 * alert (webhook) so a breaking change is a message, not a surprise.
 *
 * Primary source: a standard GraphQL introspection query POSTed
 * directly to api.buffer.com with BUFFER_API_KEY (API-first, like every
 * other product access here). This REPLACED the original source — the
 * Buffer MCP server's `introspect_schema` advanced tool — on 2026-10-31,
 * after Buffer removed the advanced trio (introspect_schema /
 * execute_query / execute_mutation) from the hosted MCP server's tool
 * list (verified live 2026-10-31: 17 tools, trio absent; the watcher
 * would have silently degraded to the docs scan forever). Fallback: a
 * scan of Buffer's published docs/changelog pages. Either way the diff
 * target is the same pinned snapshot, and the report shape is identical.
 *
 * No CARD filing yet — claims are raised as Discord alerts here; CARD
 * ingestion hooks in where the alert is sent (marked below).
 */
import snapshot from "./contentitem-snapshot.json";

export interface DriftReport {
  checkedAt: string;
  source: "graphql-introspection" | "docs-scan";
  missingOperations: string[];
  newOperations: string[];
  missingUpdateFields: string[];
  newUpdateFields: string[];
  hasDrift: boolean;
  summary: string;
}

function buildReport(
  source: DriftReport["source"],
  liveOps: Set<string>,
  liveFields: Set<string>,
): DriftReport {
  const pinnedOps = new Set(snapshot.contentItemOperations);
  const pinnedFields = new Set(snapshot.updateContentItemInputFields);

  const missingOperations = [...pinnedOps].filter((op) => !liveOps.has(op));
  const newOperations = [...liveOps].filter((op) => !pinnedOps.has(op));
  const missingUpdateFields = [...pinnedFields].filter((f) => !liveFields.has(f));
  const newUpdateFields = [...liveFields].filter((f) => !pinnedFields.has(f));

  const hasDrift =
    missingOperations.length > 0 ||
    newOperations.length > 0 ||
    missingUpdateFields.length > 0 ||
    newUpdateFields.length > 0;

  const bits: string[] = [];
  if (missingOperations.length) bits.push(`operations no longer found: ${missingOperations.join(", ")}`);
  if (newOperations.length) bits.push(`new operations: ${newOperations.join(", ")}`);
  if (missingUpdateFields.length) bits.push(`UpdateContentItemInput fields gone: ${missingUpdateFields.join(", ")}`);
  if (newUpdateFields.length) bits.push(`UpdateContentItemInput fields added: ${newUpdateFields.join(", ")}`);

  return {
    checkedAt: new Date().toISOString(),
    source,
    missingOperations,
    newOperations,
    missingUpdateFields,
    newUpdateFields,
    hasDrift,
    summary: hasDrift
      ? `ContentItem drift vs ${snapshot.snapshotDate} snapshot (via ${source}) — ${bits.join("; ")}`
      : `No ContentItem drift vs ${snapshot.snapshotDate} snapshot (via ${source})`,
  };
}

// ---------------------------------------------------------------
// Source 1: direct GraphQL introspection (api.buffer.com)
// ---------------------------------------------------------------

/** Yield every object in a JSON tree (introspection envelopes vary). */
function* walkObjects(node: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walkObjects(child);
  } else if (node && typeof node === "object") {
    yield node as Record<string, unknown>;
    for (const child of Object.values(node)) yield* walkObjects(child);
  }
}

function fieldNamesOf(typeObj: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const key of ["fields", "inputFields"] as const) {
    const list = typeObj[key];
    if (Array.isArray(list)) {
      for (const f of list) {
        if (f && typeof f === "object" && typeof (f as { name?: unknown }).name === "string") {
          names.add((f as { name: string }).name);
        }
      }
    }
  }
  return names;
}

/** Diff an introspection payload against the pinned snapshot. Accepts
 * the standard GraphQL introspection shape ({ data: { __schema } }) or
 * a bare __schema object. */
export function diffIntrospectionAgainstSnapshot(payload: unknown): DriftReport {
  const root = (payload ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;
  const schema = (data.__schema ?? data) as Record<string, unknown>;
  const mutationName =
    (schema.mutationType as { name?: string } | undefined)?.name ?? "Mutation";
  let operations = new Set<string>();
  let updateFields = new Set<string>();
  for (const obj of walkObjects(schema)) {
    if (obj.name === mutationName) {
      for (const name of fieldNamesOf(obj)) {
        if (/contentitem/i.test(name)) operations.add(name);
      }
    }
    if (obj.name === "UpdateContentItemInput") {
      updateFields = fieldNamesOf(obj);
    }
  }
  return buildReport("graphql-introspection", operations, updateFields);
}

const INTROSPECTION_QUERY = `query DriftIntrospection {
  __schema {
    mutationType { name }
    types {
      name
      fields { name }
      inputFields { name }
    }
  }
}`;

/** Fetch the live schema via direct GraphQL introspection (api.buffer.com). */
async function fetchSchemaViaGraphql(apiKey: string): Promise<unknown> {
  const res = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });
  if (!res.ok) {
    throw new Error(`Buffer introspection failed: HTTP ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------
// Source 2 (fallback): published docs scan
// ---------------------------------------------------------------

const DOCS_PAGES = [
  "https://developers.buffer.com/guides/content-items.html",
  "https://developers.buffer.com/changelog.html",
];

async function fetchDocsText(): Promise<string> {
  const parts: string[] = [];
  for (const url of DOCS_PAGES) {
    const res = await fetch(url);
    if (res.ok) parts.push(await res.text());
  }
  return parts.join("\n");
}

function extractOperations(text: string): Set<string> {
  const found = new Set<string>();
  const pattern = /\b(create|promote|add|remove|update|delete|archive)[A-Z][A-Za-z]*ContentItem[A-Za-z]*\b/g;
  for (const match of text.matchAll(pattern)) found.add(match[0]);
  for (const known of snapshot.contentItemOperations) {
    if (text.includes(known)) found.add(known);
  }
  return found;
}

function extractUpdateFields(text: string): Set<string> {
  const fields = new Set<string>();
  const idx = text.indexOf("UpdateContentItemInput");
  if (idx >= 0) {
    const window = text.slice(idx, idx + 4000);
    for (const candidate of ["id", "title", "targetDate", "tagIds", "organizationId"]) {
      if (new RegExp(`\\b${candidate}\\b`).test(window)) fields.add(candidate);
    }
  }
  return fields;
}

export function diffDocsAgainstSnapshot(liveText: string): DriftReport {
  return buildReport(
    "docs-scan",
    extractOperations(liveText),
    extractUpdateFields(liveText),
  );
}

// ---------------------------------------------------------------

export interface DriftEnv {
  DRIFT_ALERT_WEBHOOK_URL?: string;
  BUFFER_API_KEY?: string;
}

/** Run one drift check; alert on drift. Returns the report either way. */
export async function runDriftCheck(env: DriftEnv): Promise<DriftReport> {
  let report: DriftReport;
  if (env.BUFFER_API_KEY) {
    try {
      const schema = await fetchSchemaViaGraphql(env.BUFFER_API_KEY);
      report = diffIntrospectionAgainstSnapshot(schema);
    } catch (err) {
      console.error("drift check via GraphQL introspection failed, falling back to docs scan", err);
      report = diffDocsAgainstSnapshot(await fetchDocsText());
    }
  } else {
    report = diffDocsAgainstSnapshot(await fetchDocsText());
  }

  if (report.hasDrift && env.DRIFT_ALERT_WEBHOOK_URL) {
    // TODO (build week): file the same event as a CARD claim with this
    // report as evidence, per AGENT-SCOPE.md ("Knowledge/evidence").
    await fetch(env.DRIFT_ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `⚠️ Buffer ContentItem API drift detected\n${report.summary}`,
      }),
    }).catch((err) => console.error("drift alert failed", err));
  }
  return report;
}
