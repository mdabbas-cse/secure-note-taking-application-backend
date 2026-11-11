/**
 * Helpers to summarise explain('executionStats') output across both explain
 * formats (classic and SBE "explainVersion 2") and aggregation explains.
 */
export interface PlanSummary {
  stages: string[];
  indexNames: string[];
  lookupIndexesUsed: string[];
  totalKeysExamined: number;
  totalDocsExamined: number;
  nReturned: number;
}

function walk(node: unknown, visit: (value: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visit));
    return;
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    visit(record);
    Object.values(record).forEach((value) => walk(value, visit));
  }
}

/** Only the winning plan + execution stats (rejected plans would add noise). */
function relevantParts(explain: unknown): unknown[] {
  const parts: unknown[] = [];
  walk(explain, (record) => {
    const planner = record.queryPlanner as Record<string, unknown> | undefined;
    if (planner?.winningPlan) parts.push(planner.winningPlan);
    if (record.executionStats) parts.push(record.executionStats);
    // $lookup stats live on the stage object itself.
    if (Array.isArray(record.indexesUsed)) parts.push({ lookupIndexesUsed: record.indexesUsed });
  });
  return parts;
}

export function summarizeExplain(explain: unknown): PlanSummary {
  const summary: PlanSummary = {
    stages: [],
    indexNames: [],
    lookupIndexesUsed: [],
    totalKeysExamined: 0,
    totalDocsExamined: 0,
    nReturned: 0,
  };
  const seenStats = new Set<unknown>();

  for (const part of relevantParts(explain)) {
    walk(part, (record) => {
      if (typeof record.stage === 'string') summary.stages.push(record.stage);
      if (typeof record.indexName === 'string') summary.indexNames.push(record.indexName);
      if (Array.isArray(record.lookupIndexesUsed)) {
        summary.lookupIndexesUsed.push(...(record.lookupIndexesUsed as string[]));
      }
      if (typeof record.totalKeysExamined === 'number' && !seenStats.has(record)) {
        seenStats.add(record);
        summary.totalKeysExamined += record.totalKeysExamined;
        summary.totalDocsExamined += Number(record.totalDocsExamined ?? 0);
        summary.nReturned += Number(record.nReturned ?? 0);
      }
    });
  }
  summary.stages = [...new Set(summary.stages)];
  summary.indexNames = [...new Set(summary.indexNames)];
  summary.lookupIndexesUsed = [...new Set(summary.lookupIndexesUsed)];
  return summary;
}
