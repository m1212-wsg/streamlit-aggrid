import type { CellValueChangedEvent, GridApi } from "ag-grid-community"


export type BulkEditOperation = "paste" | "cut" | "delete" | "fill"

type BulkEditBoundary = {
  operation: BulkEditOperation
  endEventName: string
}
export const BULK_EDIT_START_EVENTS: Record<string, BulkEditBoundary> = {
  pasteStart: { operation: "paste", endEventName: "pasteEnd" },
  cutStart: { operation: "cut", endEventName: "cutEnd" },
  cellSelectionDeleteStart: {
    operation: "delete",
    endEventName: "cellSelectionDeleteEnd",
  },
  // AG Grid still emits the deprecated range-delete events for legacy users.
  rangeDeleteStart: {
    operation: "delete",
    endEventName: "cellSelectionDeleteEnd",
  },
  fillStart: { operation: "fill", endEventName: "fillEnd" },
}

export const BULK_EDIT_END_EVENTS: Record<string, BulkEditBoundary> = {
  pasteEnd: { operation: "paste", endEventName: "pasteEnd" },
  cutEnd: { operation: "cut", endEventName: "cutEnd" },
  cellSelectionDeleteEnd: {
    operation: "delete",
    endEventName: "cellSelectionDeleteEnd",
  },
  rangeDeleteEnd: {
    operation: "delete",
    endEventName: "cellSelectionDeleteEnd",
  },
  fillEnd: { operation: "fill", endEventName: "fillEnd" },
}

export const BULK_EDIT_BOUNDARY_EVENTS = new Set([
  ...Object.keys(BULK_EDIT_START_EVENTS),
  ...Object.keys(BULK_EDIT_END_EVENTS),
])

export type BufferedCellChange = CellValueChangedEvent & {
  type: "cellValueChanged"
}

/**
 * Per-grid buffer for one bracketed AG Grid bulk edit.
 *
 * Cell changes intentionally retain their native node, column, row-data,
 * context, and API references. A CUSTOM collector therefore sees the same
 * shape it receives for a normal cellValueChanged event and can project only
 * the business fields it needs. Nothing raw crosses the component boundary
 * unless the custom collector explicitly returns it.
 */
export class BulkEditBatch {
  readonly operation: BulkEditOperation
  readonly endEventName: string
  readonly gridApi: GridApi
  readonly editedRowIds = new Set<string>()

  endEvent: any
  finalizeScheduled = false

  private readonly changes = new Map<string, BufferedCellChange>()
  private readonly anonymousNodes = new WeakMap<object, number>()
  private nextAnonymousNodeId = 0

  constructor(
    operation: BulkEditOperation,
    endEventName: string,
    gridApi: GridApi,
    startEvent: any
  ) {
    this.operation = operation
    this.endEventName = endEventName
    this.gridApi = gridApi
    this.endEvent = startEvent
  }

  record(event: CellValueChangedEvent): void {
    const key = this.cellKey(event)
    const previous = this.changes.get(key)

    // A callback/value setter can change one cell more than once during a
    // single operation. Keep its first old value and its final native event.
    const change = {
      ...event,
      api: event.api,
      column: event.column,
      colDef: event.colDef,
      context: event.context,
      data: event.data,
      node: event.node,
      oldValue: previous ? previous.oldValue : event.oldValue,
      type: "cellValueChanged" as const,
    }
    this.changes.set(key, change)
  }

  get size(): number {
    return this.changes.size
  }

  cellChanges(): BufferedCellChange[] {
    return Array.from(this.changes.values())
  }

  private cellKey(event: CellValueChangedEvent): string {
    const node = event.node
    let rowIdentity: string

    if (node?.id !== undefined && node.id !== null) {
      rowIdentity = `id:${String(node.id)}`
    } else if (event.rowIndex !== undefined && event.rowIndex !== null) {
      rowIdentity = `index:${String(event.rowIndex)}`
    } else if (node && typeof node === "object") {
      let anonymousId = this.anonymousNodes.get(node)
      if (anonymousId === undefined) {
        anonymousId = this.nextAnonymousNodeId++
        this.anonymousNodes.set(node, anonymousId)
      }
      rowIdentity = `node:${anonymousId}`
    } else {
      rowIdentity = `unknown:${this.nextAnonymousNodeId++}`
    }

    const rowPinned = event.rowPinned ?? node?.rowPinned ?? ""
    const columnId =
      event.column?.getColId?.() ?? event.colDef?.field ?? "__unknown_column__"
    return `${rowPinned}\u0000${rowIdentity}\u0000${columnId}`
  }
}
