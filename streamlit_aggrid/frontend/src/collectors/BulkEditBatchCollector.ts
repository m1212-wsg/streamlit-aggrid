import { BaseCollector } from "./BaseCollector"
import type { CollectorContext, CollectorResult } from "./types"


const MAX_VALUE_DEPTH = 20

const sanitizeValue = (
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
  depth = 0
): unknown => {
  if (depth > MAX_VALUE_DEPTH) return undefined
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) return value
  // Preserve exact clipboard values above Number.MAX_SAFE_INTEGER.
  if (typeof value === "bigint") return String(value)
  if (value instanceof Date) return value.toISOString()
  if (!value || typeof value !== "object") return undefined
  if (ancestors.has(value)) return undefined

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value
        .map((item) => sanitizeValue(item, ancestors, depth + 1))
        .filter((item) => item !== undefined)
    }

    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      const sanitized = sanitizeValue(child, ancestors, depth + 1)
      if (sanitized !== undefined) result[key] = sanitized
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Compact response for non-CUSTOM modes during an opt-in bulk edit.
 *
 * Legacy collectors normally walk every row in the grid. Paste/cut/delete/fill
 * already provide exact cell changes, so returning only those changes avoids a
 * full-grid serialization and one response per affected cell.
 */
export class BulkEditBatchCollector extends BaseCollector {
  constructor(private readonly baseCollector?: BaseCollector) {
    super()
  }

  async processResponse(context: CollectorContext): Promise<CollectorResult> {
    const event = context.eventData || {}
    const changes = Array.isArray(event.cellChanges) ? event.cellChanges : []
    const changedCells = changes.map((change: any) => ({
      rowId: change.node?.id ?? null,
      rowIndex: change.rowIndex ?? change.node?.rowIndex ?? null,
      rowPinned: change.rowPinned ?? change.node?.rowPinned ?? null,
      columnId:
        change.column?.getColId?.() ?? change.colDef?.field ?? null,
      oldValue: sanitizeValue(change.oldValue),
      newValue: sanitizeValue(change.newValue),
    }))

    const operation = event.bulkEditOperation ?? "paste"
    const trigger = context.streamlitRerunEventTriggerName
    const batchResponse = {
      eventData: {
        type: trigger,
        source: sanitizeValue(event.source) ?? null,
        bulkEditOperation: operation,
        streamlitRerunEventTriggerName: trigger,
      },
      // Keep the clipboard-oriented public name because this API is primarily
      // intended for Excel paste/cut. The operation field also distinguishes
      // range delete and fill batches handled by the same safety primitive.
      clipboardBatch: {
        operation,
        gridId: event.api?.getGridId?.() ?? null,
        changedCells,
      },
    }

    if (!this.baseCollector) return this.createSuccessResult(batchResponse)

    // The legacy collector needs the GridApi from context.state, not the raw
    // native events. Avoid making its generic event sanitizer traverse
    // cellChanges, row nodes, columns, and circular API objects.
    const baseResult = await this.baseCollector.processResponse({
      ...context,
      eventData: {
        type: trigger,
        source: event.source,
        bulkEditOperation: operation,
      },
    })
    if (!baseResult.success) return baseResult
    return this.createSuccessResult({
      ...(baseResult.data || {}),
      ...batchResponse,
    })
  }

  getCollectorType(): string {
    return this.baseCollector
      ? `BulkEditBatchCollector(${this.baseCollector.getCollectorType()})`
      : "BulkEditBatchCollector"
  }
}
