import { AgGridReact } from "ag-grid-react"
import React, { useState, useRef, useEffect, useCallback, useMemo } from "react"
import ReactDOM from "react-dom/client"
import type { Root } from "react-dom/client"

import { Component, ComponentArgs } from '@streamlit/component-v2-lib'

import {
  AllCommunityModule,
  CellValueChangedEvent,
  DetailGridInfo,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  IRowNode,
  ModuleRegistry,
  ColumnState,
  GridState,
  RowDragEndEvent,
  DateEditorModule,
  LargeTextEditorModule
} from "ag-grid-community"

import { AgChartsEnterpriseModule } from "ag-charts-enterprise"
import { AllEnterpriseModule, LicenseManager } from "ag-grid-enterprise"

import debounce from 'lodash/debounce'
import cloneDeep from 'lodash/cloneDeep'
import isEqual from 'lodash/isEqual'
import omit from 'lodash/omit'

import { ThemeParser, type StAggridThemeOptions } from "./ThemeParser"
import {
  BulkEditBatchCollector,
  CustomCollector,
  LegacyCollector,
  MinimalCollector,
} from "./collectors"
import type { CollectorContext } from "./collectors"
import {
  BULK_EDIT_BOUNDARY_EVENTS,
  BULK_EDIT_END_EVENTS,
  BULK_EDIT_START_EVENTS,
  BulkEditBatch,
} from "./bulkEditBatching"

import "./AgGrid.css"

import GridToolBar from "./components/GridToolBar"

import {
  getCSS,
  injectProScript,
  parseJsCodeFromPython,
} from "./utils/gridUtils"

import { parseGridOptions, parseData } from "./utils/parsers"

type CSSDict = { [key: string]: { [key: string]: string } }

type stAggridStateShape = {
  gridState: GridState,
  grid_response: any
  _server_sync?: string
}

interface AgGridData {
  custom_css?: CSSDict
  pro_assets?: any[]
  enable_enterprise_modules?: any
  license_key?: string
  gridOptions?: any
  height?: number
  update_on?: any[]
  data_return_mode?: string
  debug?: boolean
  theme?: StAggridThemeOptions
  data_hash?: string
  server_sync_strategy?: string
  _server_sync_render_token?: string
  _server_sync_has_render_marker?: boolean
  clipboard_batching?: boolean
  columns_state?: any
  manual_update?: boolean
  show_toolbar?: boolean
  show_search?: boolean
  show_download_button?: boolean
  should_grid_return?: any
  custom_jscode_for_grid_return?: any
  [key: string]: any
}

type AgGridProps = Pick<
  ComponentArgs<stAggridStateShape, AgGridData>,
  "data" | "parentElement" | "setStateValue"
> & {
  componentRenderSequence: number
}

type ProReturnHandler = (
  eventData: any,
  streamlitRerunEventTriggerName: string
) => Promise<void>

type ReturnGridValueOptions = {
  bulkEditBatch?: boolean
}

type ServerCellMutation = {
  generation: number
  node?: IRowNode
  field?: string
  structural: boolean
}

type OutstandingServerReturn = {
  token: string
  submittedGeneration: number
}

type QueuedServerReturn = {
  eventData: any
  triggerName: string
  returnOptions?: ReturnGridValueOptions
  submittedGeneration?: number
}

type WithheldServerCell = {
  node: IRowNode
  field: string
  value: any
  withheldAtGeneration: number
}

type ServerApplyResult = "applied" | "deferred" | "skipped"

const LEGACY_FULL_FRAME_RETURN_MODES = new Set([
  "AS_INPUT",
  "FILTERED",
  "FILTERED_AND_SORTED",
])
const SERVER_SYNC_EVENT_SOURCE = "streamlitAgGridServerSync"

const mergeServerRowWithProtectedFields = (
  node: IRowNode,
  incoming: any,
  protectedFields?: Set<string>
): any => {
  if (
    !protectedFields?.size ||
    incoming == null ||
    typeof incoming !== "object" ||
    node.data == null ||
    typeof node.data !== "object"
  ) return incoming

  const merged = cloneDeep(incoming)
  for (const field of protectedFields) {
    if (Object.prototype.hasOwnProperty.call(node.data, field)) {
      merged[field] = cloneDeep(node.data[field])
    } else {
      delete merged[field]
    }
  }
  return merged
}

type ProReturnRegistration = {
  handler: ProReturnHandler
  ownsApi: (api: GridApi) => boolean
}

type ProReturnRegistry = {
  originalHandler: any
  dispatcher: (...args: any[]) => any
  registrations: Map<symbol, ProReturnRegistration>
}

type RowReconciliationResult = {
  rowData?: any[]
  reusedRows: number
  fallbackReason?: string
}

const normalizeForSignature = (
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet()
): unknown => {
  if (value === undefined) return ["__streamlit_aggrid_undefined__"]
  if (typeof value === "bigint") return ["__streamlit_aggrid_bigint__", String(value)]
  if (typeof value === "function") {
    return ["__streamlit_aggrid_function__", String(value)]
  }
  if (typeof value === "symbol") {
    return ["__streamlit_aggrid_symbol__", String(value)]
  }
  if (value === null || typeof value !== "object") return value
  if (value instanceof Date) return ["__streamlit_aggrid_date__", value.toISOString()]
  if (ancestors.has(value)) return ["__streamlit_aggrid_circular__"]

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeForSignature(entry, ancestors))
    }

    const normalized: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeForSignature(
        (value as Record<string, unknown>)[key],
        ancestors
      )
    }
    return normalized
  } finally {
    ancestors.delete(value)
  }
}

const stableSignature = (value: unknown): string =>
  JSON.stringify(normalizeForSignature(value))

const asGridOptionsObject = (rawGridOptions: unknown): Record<string, any> => {
  if (typeof rawGridOptions === "string") {
    try {
      const parsed = JSON.parse(rawGridOptions)
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      return {}
    }
  }
  return rawGridOptions && typeof rawGridOptions === "object"
    ? rawGridOptions as Record<string, any>
    : {}
}

// AG Grid 36 rejects these options when they are passed through
// api.updateGridOptions(). Keep this list in sync with
// ag-grid-community/dist/types/src/gridOptionsInitial.d.ts while v36 is pinned.
const INITIAL_ONLY_GRID_OPTION_KEYS = new Set([
  "enableBrowserTooltips",
  "tooltipTrigger",
  "tooltipMouseTrack",
  "tooltipShowMode",
  "tooltipInteraction",
  "defaultColGroupDef",
  "suppressAutoSize",
  "skipHeaderOnAutoSize",
  "autoSizeStrategy",
  "components",
  "stopEditingWhenCellsLoseFocus",
  "undoRedoCellEditing",
  "undoRedoCellEditingLimit",
  "excelStyles",
  "cacheQuickFilter",
  "customChartThemes",
  "chartThemeOverrides",
  "chartToolPanelsDef",
  "loadingCellRendererSelector",
  "localeText",
  "keepDetailRows",
  "keepDetailRowsCount",
  "detailRowHeight",
  "detailRowAutoHeight",
  "tabIndex",
  "valueCache",
  "valueCacheNeverExpires",
  "enableCellExpressions",
  "suppressTouch",
  "suppressBrowserResizeObserver",
  "suppressPropertyNamesCheck",
  "debug",
  "dragAndDropImageComponent",
  "overlayComponent",
  "suppressOverlays",
  "loadingOverlayComponent",
  "suppressLoadingOverlay",
  "noRowsOverlayComponent",
  "paginateChildRows",
  "pivotPanelShow",
  "pivotSuppressAutoColumn",
  "suppressExpandablePivotGroups",
  "aggFuncs",
  "allowShowChangeAfterFilter",
  "ensureDomOrder",
  "enableRtl",
  "suppressColumnVirtualisation",
  "suppressMaxRenderedRowRestriction",
  "suppressRowVirtualisation",
  "rowDragText",
  "groupLockGroupColumns",
  "suppressGroupRowsSticky",
  "rowModelType",
  "cacheOverflowSize",
  "infiniteInitialRowCount",
  "serverSideInitialRowCount",
  "maxBlocksInCache",
  "maxConcurrentDatasourceRequests",
  "blockLoadDebounceMillis",
  "serverSideOnlyRefreshFilteredGroups",
  "serverSidePivotResultFieldSeparator",
  "viewportRowModelPageSize",
  "viewportRowModelBufferSize",
  "debounceVerticalScrollbar",
  "suppressAnimationFrame",
  "suppressPreventDefaultOnMouseWheel",
  "scrollbarWidth",
  "icons",
  "suppressRowTransform",
  "suppressContentVisibilityAuto",
  "gridId",
  "enableGroupEdit",
  "initialState",
  "processUnpinnedColumns",
  "createChartContainer",
  "getLocaleText",
  "getRowId",
  "reactiveCustomComponents",
  "renderingMode",
  "columnMenu",
  "suppressSetFilterByDefault",
  "getDataPath",
  "enableCellSpan",
  "enableFilterHandlers",
  "filterHandlers",
])

const runtimeGridOptions = (
  gridOptions: Record<string, any>
): Record<string, any> => {
  const runtimeOptions: Record<string, any> = {}
  for (const [key, value] of Object.entries(gridOptions)) {
    if (
      key !== "rowData" &&
      key !== "theme" &&
      !INITIAL_ONLY_GRID_OPTION_KEYS.has(key)
    ) {
      runtimeOptions[key] = value
    }
  }
  return runtimeOptions
}

const initialOnlyGridOptionSignatures = (
  gridOptions: Record<string, any>
): Record<string, string> => {
  const signatures: Record<string, string> = {}
  for (const key of INITIAL_ONLY_GRID_OPTION_KEYS) {
    signatures[key] = stableSignature(gridOptions[key])
  }
  return signatures
}

/**
 * Preserve the existing data object for rows whose stable ID and values did
 * not change. Passing that mixed old/new array back through AG Grid's immutable
 * row-data path lets the grid update only changed rows while still applying
 * server additions, removals, and order.
 *
 * Invalid or duplicate IDs reject the update. Passing the incoming array to AG
 * Grid in that case would still run the same invalid getRowId callback through
 * its immutable-data path and could corrupt the row model.
 */
const reconcileServerRows = (
  api: GridApi,
  incomingRows: any[],
): RowReconciliationResult => {
  if (incomingRows.length === 0) {
    return { rowData: [], reusedRows: 0 }
  }

  const getRowId = api.getGridOption("getRowId")
  if (typeof getRowId !== "function") {
    return {
      reusedRows: 0,
      fallbackReason: "getRowId is not a function",
    }
  }

  const existingRowsById = new Map<string, any>()
  let fallbackReason: string | undefined

  api.forEachLeafNode((node) => {
    if (fallbackReason || node.data == null) return
    if (node.id == null) {
      fallbackReason = "an existing row has no ID"
      return
    }
    if (existingRowsById.has(node.id)) {
      fallbackReason = `existing row ID ${JSON.stringify(node.id)} is duplicated`
      return
    }
    existingRowsById.set(node.id, node.data)
  })

  if (fallbackReason) {
    return { reusedRows: 0, fallbackReason }
  }

  const incomingIds = new Set<string>()
  const reconciledRows: any[] = []
  let reusedRows = 0

  for (const data of incomingRows) {
    let rawId: unknown
    try {
      rawId = getRowId({
        api,
        context: api.getGridOption("context"),
        data,
        level: 0,
      } as GetRowIdParams)
    } catch (error) {
      return {
        reusedRows: 0,
        fallbackReason: `getRowId threw: ${String(error)}`,
      }
    }

    if (rawId == null) {
      return {
        reusedRows: 0,
        fallbackReason: "getRowId returned null or undefined",
      }
    }

    const rowId = String(rawId)
    if (incomingIds.has(rowId)) {
      return {
        reusedRows: 0,
        fallbackReason: `incoming row ID ${JSON.stringify(rowId)} is duplicated`,
      }
    }
    incomingIds.add(rowId)

    const existingData = existingRowsById.get(rowId)
    if (existingData !== undefined && isEqual(existingData, data)) {
      reconciledRows.push(existingData)
      reusedRows += 1
    } else {
      reconciledRows.push(data)
    }
  }

  return { rowData: reconciledRows, reusedRows }
}

const proReturnRegistries = new WeakMap<object, ProReturnRegistry>()

/**
 * StreamlitAgGridPro exposes one historical global return hook. Keep that API,
 * but dispatch events carrying an AG Grid API to the component that owns it.
 * Calls without an API preserve the old last-registered-grid behaviour.
 */
const registerProReturnHandler = (
  target: Record<string, any>,
  owner: symbol,
  registration: ProReturnRegistration
): (() => void) => {
  let registry = proReturnRegistries.get(target)

  if (!registry) {
    const registrations = new Map<symbol, ProReturnRegistration>()
    const originalHandler = target.returnGridValue
    const dispatcher = (...args: any[]) => {
      const activeRegistry = proReturnRegistries.get(target)
      if (!activeRegistry) {
        return typeof originalHandler === "function"
          ? originalHandler.apply(target, args)
          : undefined
      }

      const entries = Array.from(activeRegistry.registrations.values())
      const eventApi = args[0]?.api
      let matched: ProReturnRegistration | undefined
      if (eventApi) {
        for (let index = entries.length - 1; index >= 0; index--) {
          if (entries[index].ownsApi(eventApi)) {
            matched = entries[index]
            break
          }
        }
      }
      const active = matched || entries[entries.length - 1]

      if (active) return active.handler(args[0], args[1])
      return typeof activeRegistry.originalHandler === "function"
        ? activeRegistry.originalHandler.apply(target, args)
        : undefined
    }

    registry = { originalHandler, dispatcher, registrations }
    proReturnRegistries.set(target, registry)
  }

  registry.registrations.set(owner, registration)
  target.returnGridValue = registry.dispatcher

  return () => {
    const activeRegistry = proReturnRegistries.get(target)
    if (!activeRegistry) return

    activeRegistry.registrations.delete(owner)
    if (activeRegistry.registrations.size > 0) return

    if (target.returnGridValue === activeRegistry.dispatcher) {
      target.returnGridValue = activeRegistry.originalHandler
    }
    proReturnRegistries.delete(target)
  }
}


const renderAgGrid: Component<stAggridStateShape, AgGridData> = (componentArgs) => {
  const { parentElement, ...restArgs } = componentArgs
  
  let reactRoot = reactRoots.get(parentElement)
  if (!reactRoot) {
    reactRoot = ReactDOM.createRoot(parentElement)
    reactRoots.set(parentElement, reactRoot)
  }

  const componentRenderSequence =
    (componentRenderSequences.get(parentElement) || 0) + 1
  componentRenderSequences.set(parentElement, componentRenderSequence)

  reactRoot.render(

      <AgGrid
        parentElement={parentElement}
        componentRenderSequence={componentRenderSequence}
        {...omit(restArgs, 'key')}
      />

  )

  return () => {
    const root = reactRoots.get(parentElement)
    if (root) {
      root.unmount()
      reactRoots.delete(parentElement)
      componentRenderSequences.delete(parentElement)
    }
  }
}

export default renderAgGrid


const AgGrid: React.FC<AgGridProps> = (props) => {

  const rawGridOptions = useMemo(
    () => asGridOptionsObject(props.data?.gridOptions),
    [props.data?.gridOptions]
  )
  const rawGridOptionsWithoutRowData = useMemo(
    () => omit(rawGridOptions, ["rowData"]),
    [rawGridOptions]
  )
  const gridOptionsInputSignature = stableSignature({
    allowUnsafeJsCode: props.data?.allow_unsafe_jscode === true,
    gridOptions: rawGridOptionsWithoutRowData,
  })
  const themeInputSignature = stableSignature(props.data?.theme)
  const columnsStateInputSignature = stableSignature(props.data?.columns_state)
  const componentHostElement =
    props.parentElement instanceof HTMLElement
      ? props.parentElement
      : props.parentElement.host
  const isInsideStreamlitForm =
    componentHostElement.closest('[data-testid="stForm"]') !== null

  // Refs (non-reactive values)
  const gridContainerRef = useRef<HTMLDivElement>(null)
  const renderedGridHeightPrevious = useRef(0)
  const themeParserRef = useRef<ThemeParser>(new ThemeParser())
  const shouldGridReturnRef = useRef<Function | undefined>(
    props.data?.should_grid_return
      ? parseJsCodeFromPython(props.data.should_grid_return)
      : undefined
  )
  const collectGridReturnRef = useRef<Function | undefined>(
    props.data?.custom_jscode_for_grid_return
      ? parseJsCodeFromPython(props.data.custom_jscode_for_grid_return)
      : undefined
  )
  const modulesRegisteredRef = useRef(false)
  const lastEnterpriseLicenseKeyRef = useRef<string | undefined>(undefined)
  const isMountedRef = useRef(true)
  const returnSequenceRef = useRef(0)
  const eventListenerCleanupsRef = useRef<Map<GridApi, Array<() => void>>>(new Map())
  const gridLifecycleCleanupRef = useRef<(() => void) | undefined>(undefined)
  const proReturnOwnerRef = useRef(Symbol("streamlit-aggrid-instance"))
  const dataHashRef = useRef(props.data?.data_hash)
  const latestComponentDataRef = useRef(props.data)
  const latestDebugRef = useRef(props.data?.debug === true)
  const isApplyingServerDataRef = useRef(false)
  const serverDataDirtyRef = useRef(false)
  const serverDataEditSequenceRef = useRef(0)
  const serverCellMutationsRef = useRef<ServerCellMutation[]>([])
  const outstandingServerReturnRef = useRef<
    OutstandingServerReturn | undefined
  >(undefined)
  const latestUnqueuedServerReturnRef = useRef<
    OutstandingServerReturn | undefined
  >(undefined)
  const queuedServerReturnsRef = useRef<QueuedServerReturn[]>([])
  const withheldServerCellsRef = useRef<WithheldServerCell[]>([])
  const deferredServerComponentDataRef = useRef<AgGridData | undefined>(
    undefined
  )
  const deferredServerEditSequenceRef = useRef<number | undefined>(undefined)
  const serverApplyFrameRef = useRef<number | undefined>(undefined)
  const releaseOutstandingServerReturnRef = useRef<
    (accepted: boolean) => void
  >(() => undefined)
  const activeBulkEditBatchesRef = useRef<WeakMap<GridApi, BulkEditBatch>>(
    new WeakMap()
  )
  const bulkEditGenerationRef = useRef<WeakMap<GridApi, number>>(new WeakMap())
  const serverSyncStrategyRef = useRef(
    props.data?.server_sync_strategy || "client_wins"
  )
  const previousServerSyncStrategyRef = useRef(
    props.data?.server_sync_strategy || "client_wins"
  )
  const rowReconciliationWarningsRef = useRef<Set<string>>(new Set())
  const initialOnlyOptionWarningsRef = useRef<Set<string>>(new Set())
  const lastGridOptionsInputSignatureRef = useRef(gridOptionsInputSignature)
  const lastThemeInputSignatureRef = useRef(themeInputSignature)
  const lastColumnsStateInputSignatureRef = useRef<string | undefined>(undefined)
  const returnGridValueRef = useRef<
    (
      eventData: any,
      streamlitRerunEventTriggerName: string,
      returnOptions?: ReturnGridValueOptions,
      submittedGenerationOverride?: number
    ) => Promise<void>
  >(async () => undefined)


  // Initial grid options (stable reference, updates handled via AG Grid API)
  const gridOptionsRef = useRef<any>()
  const initialOnlyGridOptionSignaturesRef = useRef<Record<string, string>>()

  if (!gridOptionsRef.current) {
    // Initialize once on first render
    if (!props.data) {
      gridOptionsRef.current = {}
    } else {
      const go = parseGridOptions(
        props.data.gridOptions,
        props.data.allow_unsafe_jscode,
        props.data.theme
      )
      initialOnlyGridOptionSignaturesRef.current =
        initialOnlyGridOptionSignatures(go)
      go.rowData = parseData(props.data.data, rawGridOptions.rowData)

      // Auto-generate getRowId if not provided and data has unique IDs
      if (!("getRowId" in go) && go.rowData?.[0]?.["::auto_unique_id::"]) {
        go.getRowId = (params: GetRowIdParams) => params.data["::auto_unique_id::"]
      }

      gridOptionsRef.current = go
    }
  }

  const gridOptions = gridOptionsRef.current
  const appliedRuntimeGridOptionsRef = useRef<Record<string, any>>()
  if (!appliedRuntimeGridOptionsRef.current) {
    appliedRuntimeGridOptionsRef.current = runtimeGridOptions(gridOptions)
  }

  // Register AG Grid modules (must run before render)
  if (!modulesRegisteredRef.current) {
    const enableEnterpriseModules = props.data?.enable_enterprise_modules

    if (enableEnterpriseModules === "enterprise+AgCharts") {
      ModuleRegistry.registerModules([
        AllEnterpriseModule.with(AgChartsEnterpriseModule),
      ])
      if (props.data?.license_key) {
        LicenseManager.setLicenseKey(props.data.license_key)
        lastEnterpriseLicenseKeyRef.current = props.data.license_key
      }
    } else if (
      enableEnterpriseModules === true ||
      enableEnterpriseModules === "enterpriseOnly"
    ) {
      ModuleRegistry.registerModules([AllEnterpriseModule])
      if (props.data?.license_key) {
        LicenseManager.setLicenseKey(props.data.license_key)
        lastEnterpriseLicenseKeyRef.current = props.data.license_key
      }
    } else {
      ModuleRegistry.registerModules([AllCommunityModule, DateEditorModule, LargeTextEditorModule])
    }

    modulesRegisteredRef.current = true
  }

  // State

  const [editedRows, setEditedRows] = useState<Set<any>>(new Set())
  const [isMaximized, setIsMaximized] = useState(false)
  const [savedColumnState, setSavedColumnState] = useState<ColumnState[] | undefined>()
  const [gridReadySequence, setGridReadySequence] = useState(0)
  const apiRef = useRef<GridApi | undefined>(undefined)

  latestComponentDataRef.current = props.data
  serverSyncStrategyRef.current =
    props.data?.server_sync_strategy || "client_wins"

  // Derived values
  const debug = props.data?.debug || false
  latestDebugRef.current = debug
  const enterprise_features_enabled = props.data?.enable_enterprise_modules || false
  const clipboardBatching = props.data?.clipboard_batching === true
  const isRowDataEdited = editedRows.size > 0
  const proAssets = props.data?.pro_assets || []
  const proAssetsSignature = JSON.stringify(proAssets)
  const updateOnSignature = JSON.stringify(props.data?.update_on || [])
  const updateOn = useMemo(
    () => props.data?.update_on || [],
    [updateOnSignature]
  )

  // A licence may be loaded from Streamlit secrets after the first component
  // mount. Module registration is intentionally one-time, but applying a new
  // non-empty key is cheap and must not require changing the component key.
  useEffect(() => {
    const enterpriseEnabled =
      props.data?.enable_enterprise_modules === true ||
      props.data?.enable_enterprise_modules === "enterpriseOnly" ||
      props.data?.enable_enterprise_modules === "enterprise+AgCharts"
    const licenseKey = props.data?.license_key
    if (
      enterpriseEnabled &&
      licenseKey &&
      licenseKey !== lastEnterpriseLicenseKeyRef.current
    ) {
      LicenseManager.setLicenseKey(licenseKey)
      lastEnterpriseLicenseKeyRef.current = licenseKey
    }
  }, [props.data?.enable_enterprise_modules, props.data?.license_key])

  const runAsServerApply = useCallback((operation: () => void) => {
    const wasApplyingServerData = isApplyingServerDataRef.current
    isApplyingServerDataRef.current = true
    try {
      operation()
    } finally {
      isApplyingServerDataRef.current = wasApplyingServerData
    }
  }, [])


  // Initialization diagnostics
  useEffect(() => {
    if (debug) {
      console.log("***Received Props", props)
      console.log("*** Processed Initial State", {
        gridOptions: gridOptionsRef.current,
        editedRows,
        isMaximized,
        savedColumnState,
        dataHash: dataHashRef.current,
      })
    }
  }, [debug])

  // Keep user-provided JavaScript hooks current across Streamlit rerenders.
  useEffect(() => {
    shouldGridReturnRef.current = props.data?.should_grid_return
      ? parseJsCodeFromPython(props.data.should_grid_return)
      : undefined
    collectGridReturnRef.current = props.data?.custom_jscode_for_grid_return
      ? parseJsCodeFromPython(props.data.custom_jscode_for_grid_return)
      : undefined
  }, [
    props.data?.should_grid_return,
    props.data?.custom_jscode_for_grid_return,
  ])

  // Extension scripts live in the document and may register durable globals.
  // injectProScript content-deduplicates them so Components V2 remounts do not
  // execute the same extension more than once.
  useEffect(() => {
    const cleanups = proAssets.map((asset: any) => injectProScript(asset?.js))

    const StreamlitAgGridPro = (window as any)?.StreamlitAgGridPro
    StreamlitAgGridPro?.extenders?.forEach((extender: Function) =>
      extender(gridOptionsRef.current)
    )

    return () => cleanups.forEach((cleanup: () => void) => cleanup())
  }, [proAssetsSignature])

  // Prevent Streamlit keyboard shortcuts from interfering with grid
  // Block specific Streamlit shortcuts while allowing AG Grid to handle its own keys
  useEffect(() => {
    const container = gridContainerRef.current
    if (!container) return

    // Streamlit keyboard shortcuts that we need to block
    const streamlitShortcuts = new Set(['r', 'c'])

    const stopStreamlitShortcuts = (e: KeyboardEvent) => {
      // Only block single-key shortcuts without modifiers (Ctrl/Cmd/Alt)
      if (!e.ctrlKey && !e.metaKey && !e.altKey && streamlitShortcuts.has(e.key.toLowerCase())) {
        e.stopPropagation()
      }
    }

    container.addEventListener('keydown', stopStreamlitShortcuts, true)

    return () => {
      container.removeEventListener('keydown', stopStreamlitShortcuts, true)
    }
  }, []) 

  // Effect 1: Update only semantically changed, runtime-mutable grid options.
  // Components V2 creates fresh object identities on each invocation; using
  // object identity here would rebuild columns during otherwise row-only runs.
  useEffect(() => {
    const api = apiRef.current
    const componentData = latestComponentDataRef.current
    if (!api || !componentData) return
    if (
      gridOptionsInputSignature ===
      lastGridOptionsInputSignatureRef.current
    ) return

    try {
      const newOptions = parseGridOptions(
        componentData.gridOptions,
        componentData.allow_unsafe_jscode,
        componentData.theme
      )
      const nextRuntimeOptions = runtimeGridOptions(newOptions)
      const previousRuntimeOptions = appliedRuntimeGridOptionsRef.current || {}
      const changedOptions: Record<string, any> = {}

      for (const key of new Set([
        ...Object.keys(previousRuntimeOptions),
        ...Object.keys(nextRuntimeOptions),
      ])) {
        const nextValue = Object.prototype.hasOwnProperty.call(
          nextRuntimeOptions,
          key
        ) ? nextRuntimeOptions[key] : undefined
        if (
          stableSignature(previousRuntimeOptions[key]) !==
          stableSignature(nextValue)
        ) {
          changedOptions[key] = nextValue
        }
      }

      const initialOptionSignatures =
        initialOnlyGridOptionSignaturesRef.current || {}
      const changedInitialOnlyOptions = Array.from(
        INITIAL_ONLY_GRID_OPTION_KEYS
      ).filter((key) =>
        stableSignature((newOptions as any)[key]) !==
        initialOptionSignatures[key]
      )
      const unwarnedInitialOnlyOptions = changedInitialOnlyOptions.filter(
        (key) => !initialOnlyOptionWarningsRef.current.has(key)
      )
      if (unwarnedInitialOnlyOptions.length > 0) {
        unwarnedInitialOnlyOptions.forEach((key) =>
          initialOnlyOptionWarningsRef.current.add(key)
        )
        console.warn(
          "These AG Grid options are initial-only and their runtime changes " +
          "were ignored. Change the Streamlit component key to remount the " +
          `grid: ${unwarnedInitialOnlyOptions.sort().join(", ")}`
        )
      }

      if (Object.keys(changedOptions).length > 0) {
        latestDebugRef.current && console.log(
          "********** GridOptions updated",
          Object.keys(changedOptions)
        )
        runAsServerApply(() => api.updateGridOptions(changedOptions))
      }

      appliedRuntimeGridOptionsRef.current = nextRuntimeOptions
      lastGridOptionsInputSignatureRef.current = gridOptionsInputSignature
    } catch (error) {
      console.error("Failed to update AG Grid options:", error)
    }
  }, [
    gridOptionsInputSignature,
    gridReadySequence,
    runAsServerApply,
  ])

  // Effect 2: Theme CSS variables update through the cascade. Rebuild the AG
  // Grid theme object only when the user-selected theme recipe actually changes.
  useEffect(() => {
    const api = apiRef.current
    const componentData = latestComponentDataRef.current
    if (!api || !componentData) return
    if (themeInputSignature === lastThemeInputSignatureRef.current) return

    try {
      latestDebugRef.current && console.log("********** Theme updated")
      api.updateGridOptions({
        theme: themeParserRef.current.parse(componentData.theme),
      })
      lastThemeInputSignatureRef.current = themeInputSignature
    } catch (error) {
      console.error("Failed to update AG Grid theme:", error)
    }
  }, [gridReadySequence, themeInputSignature])

  const hasActiveGridEditor = useCallback((): boolean => {
    const gridApis = new Set(eventListenerCleanupsRef.current.keys())
    if (apiRef.current) gridApis.add(apiRef.current)
    for (const gridApi of gridApis) {
      try {
        if (!gridApi.isDestroyed() && gridApi.getEditingCells().length > 0) {
          return true
        }
      } catch {
        // Detail grids can disappear while their registry is being scanned.
      }
    }
    return false
  }, [])

  const patchServerRowsAroundEditors = useCallback(
    (
      api: GridApi,
      incomingRows: any[],
      serverSyncStrategy: string,
      protectedFields: Map<IRowNode, Set<string>>
    ): boolean => {
      for (const configuredApi of eventListenerCleanupsRef.current.keys()) {
        if (
          configuredApi !== api &&
          !configuredApi.isDestroyed() &&
          configuredApi.getEditingCells().length > 0
        ) return false
      }

      const bodyNodes: IRowNode[] = []
      api.forEachLeafNode((node) => bodyNodes.push(node))
      if (bodyNodes.length !== incomingRows.length) return false

      const getRowId = api.getGridOption("getRowId")
      if (typeof getRowId === "function") {
        for (let index = 0; index < incomingRows.length; index += 1) {
          let incomingId: unknown
          try {
            incomingId = getRowId({
              api,
              context: api.getGridOption("context"),
              data: incomingRows[index],
              level: 0,
            } as GetRowIdParams)
          } catch {
            return false
          }
          if (incomingId == null || String(incomingId) !== bodyNodes[index].id) {
            return false
          }
        }
      } else if (serverSyncStrategy === "server_wins_rows") {
        return false
      }

      const nodeIndexes = new Map(
        bodyNodes.map((node, index) => [node, index] as const)
      )
      const activeCorrections: WithheldServerCell[] = []
      for (const cell of api.getEditingCells()) {
        if (cell.rowPinned || !cell.column) return false
        const node = api.getDisplayedRowAtIndex(cell.rowIndex)
        const rowIndex = node ? nodeIndexes.get(node) : undefined
        const field = cell.column.getColDef().field?.split(".")[0]
        if (node == null || rowIndex == null || !field) return false

        const fields = protectedFields.get(node) ?? new Set<string>()
        fields.add(field)
        protectedFields.set(node, fields)
        const incoming = incomingRows[rowIndex]
        if (
          incoming &&
          typeof incoming === "object" &&
          !isEqual(node.data?.[field], incoming[field])
        ) {
          activeCorrections.push({
            node,
            field,
            value: cloneDeep(incoming[field]),
            withheldAtGeneration: serverDataEditSequenceRef.current,
          })
        }
      }

      runAsServerApply(() => {
        bodyNodes.forEach((node, index) => {
          const merged = mergeServerRowWithProtectedFields(
            node,
            incomingRows[index],
            protectedFields.get(node)
          )
          if (!isEqual(node.data, merged)) node.updateData(merged)
        })
      })

      for (const correction of activeCorrections) {
        withheldServerCellsRef.current =
          withheldServerCellsRef.current.filter(
            (current) =>
              current.node !== correction.node ||
              current.field !== correction.field
          )
        withheldServerCellsRef.current.push(correction)
      }
      return true
    },
    [runAsServerApply]
  )

  const applyAuthoritativeServerData = useCallback(
    (
      serverSyncStrategy: string,
      componentDataOverride?: AgGridData,
      protectedFields = new Map<IRowNode, Set<string>>(),
      preserveLocalMutations = false
    ): ServerApplyResult => {
      const componentData =
        componentDataOverride ?? latestComponentDataRef.current
      const api = apiRef.current
      if (!componentData || !api) return "skipped"

      const currentRawGridOptions = asGridOptionsObject(
        componentData.gridOptions
      )
      const incomingRows =
        parseData(componentData.data, currentRawGridOptions.rowData) || []
      // A newer authoritative snapshot supersedes corrections withheld from an
      // earlier render. The editor-safe patch below records fresh ones.
      withheldServerCellsRef.current = []
      const hasActiveEditor = hasActiveGridEditor()

      if (hasActiveEditor || protectedFields.size > 0) {
        const patched = patchServerRowsAroundEditors(
          api,
          incomingRows,
          serverSyncStrategy,
          protectedFields
        )
        if (!patched) {
          if (hasActiveEditor) {
            deferredServerComponentDataRef.current = componentData
            deferredServerEditSequenceRef.current =
              serverDataEditSequenceRef.current
            return "deferred"
          }
          return "skipped"
        }

        dataHashRef.current = componentData.data_hash
        if (preserveLocalMutations) {
          serverDataDirtyRef.current =
            serverCellMutationsRef.current.length > 0
        } else {
          serverCellMutationsRef.current = []
          serverDataDirtyRef.current = false
        }
        return "applied"
      }

      let rowData = incomingRows
      if (serverSyncStrategy === "server_wins_rows") {
        const reconciliation = reconcileServerRows(api, incomingRows)
        if (reconciliation.fallbackReason || !reconciliation.rowData) {
          const reason = reconciliation.fallbackReason || "unknown row-ID error"
          if (!rowReconciliationWarningsRef.current.has(reason)) {
            rowReconciliationWarningsRef.current.add(reason)
            console.warn(
              "server_wins_rows skipped an unsafe server row update and " +
              "preserved the existing grid rows:",
              reason
            )
          }
          return "skipped"
        }
        rowData = reconciliation.rowData
        latestDebugRef.current && console.log(
          `server_wins_rows reused ${reconciliation.reusedRows} of ${incomingRows.length} row objects`
        )
      }

      const bodyRows: any[] = []
      api.forEachLeafNode((node) => bodyRows.push(node.data))
      const authoritativeOptions: Record<string, any> = {}
      if (!isEqual(bodyRows, rowData)) authoritativeOptions.rowData = rowData
      for (const [pinnedOption, rowCount] of [
        ["pinnedTopRowData", () => api.getPinnedTopRowCount()],
        ["pinnedBottomRowData", () => api.getPinnedBottomRowCount()],
      ] as const) {
        if (
          Object.prototype.hasOwnProperty.call(
            currentRawGridOptions,
            pinnedOption
          )
        ) {
          authoritativeOptions[pinnedOption] = cloneDeep(
            currentRawGridOptions[pinnedOption]
          )
        } else if (rowCount() > 0) {
          authoritativeOptions[pinnedOption] = []
        }
      }

      try {
        if (Object.keys(authoritativeOptions).length > 0) {
          runAsServerApply(() => api.updateGridOptions(authoritativeOptions))
        }
      } catch (error) {
        console.error("Failed to apply authoritative server row data:", error)
        return "skipped"
      }

      dataHashRef.current = componentData.data_hash
      if (!preserveLocalMutations) {
        serverCellMutationsRef.current = []
        serverDataDirtyRef.current = false
        setEditedRows((current) => current.size > 0 ? new Set() : current)
      }
      return "applied"
    },
    [hasActiveGridEditor, patchServerRowsAroundEditors, runAsServerApply]
  )

  const releaseOutstandingServerReturn = useCallback((accepted: boolean) => {
    const queuedOutstanding = outstandingServerReturnRef.current
    const outstanding =
      queuedOutstanding ?? latestUnqueuedServerReturnRef.current
    deferredServerComponentDataRef.current = undefined
    deferredServerEditSequenceRef.current = undefined
    if (!outstanding) return

    if (accepted) {
      serverCellMutationsRef.current = serverCellMutationsRef.current.filter(
        (mutation) =>
          mutation.generation > outstanding.submittedGeneration
      )
    }
    outstandingServerReturnRef.current = undefined
    latestUnqueuedServerReturnRef.current = undefined
    serverDataDirtyRef.current = serverCellMutationsRef.current.length > 0

    const [next, ...remaining] = queuedServerReturnsRef.current
    queuedServerReturnsRef.current = remaining
    if (!next) return
    void returnGridValueRef.current(
      next.eventData,
      next.triggerName,
      next.returnOptions,
      next.submittedGeneration
    )
  }, [])
  releaseOutstandingServerReturnRef.current = releaseOutstandingServerReturn

  const retryDeferredServerApply = useCallback(() => {
    if (serverApplyFrameRef.current !== undefined) return
    serverApplyFrameRef.current = window.requestAnimationFrame(() => {
      serverApplyFrameRef.current = undefined
      if (!isMountedRef.current || hasActiveGridEditor()) return

      const deferredData = deferredServerComponentDataRef.current
      if (deferredData) {
        if (
          deferredServerEditSequenceRef.current !==
          serverDataEditSequenceRef.current
        ) {
          releaseOutstandingServerReturnRef.current(false)
        } else {
          const result = applyAuthoritativeServerData(
            serverSyncStrategyRef.current,
            deferredData,
            new Map(),
            true
          )
          if (result !== "deferred") {
            releaseOutstandingServerReturnRef.current(result === "applied")
          }
        }
      }

      for (const correction of withheldServerCellsRef.current) {
        const superseded = serverCellMutationsRef.current.some(
          (mutation) =>
            mutation.generation > correction.withheldAtGeneration &&
            mutation.node === correction.node &&
            mutation.field === correction.field
        )
        if (!superseded) {
          runAsServerApply(() =>
            correction.node.setDataValue(
              correction.field,
              correction.value,
              SERVER_SYNC_EVENT_SOURCE
            )
          )
        }
      }
      withheldServerCellsRef.current = []
    })
  }, [applyAuthoritativeServerData, hasActiveGridEditor, runAsServerApply])

  // Effect 3: Handle data sync (rowData updates).
  useEffect(() => {
    const componentData = latestComponentDataRef.current
    const api = apiRef.current
    if (!componentData || !api) return

    const serverSyncStrategy =
      componentData.server_sync_strategy || "client_wins"
    const strategyChanged =
      previousServerSyncStrategyRef.current !== serverSyncStrategy
    previousServerSyncStrategyRef.current = serverSyncStrategy
    const newHash = componentData.data_hash

    latestDebugRef.current && console.log(
      `********** Data sync (${serverSyncStrategy})`,
      {
        dataHash: dataHashRef.current,
        newHash,
        isRowDataEdited,
        serverDataDirty: serverDataDirtyRef.current,
        strategyChanged,
      }
    )

    if (serverSyncStrategy === "client_wins") {
      serverDataDirtyRef.current = false
      serverCellMutationsRef.current = []
      outstandingServerReturnRef.current = undefined
      latestUnqueuedServerReturnRef.current = undefined
      queuedServerReturnsRef.current = []
      deferredServerComponentDataRef.current = undefined
      deferredServerEditSequenceRef.current = undefined
      withheldServerCellsRef.current = []
      if (serverApplyFrameRef.current !== undefined) {
        window.cancelAnimationFrame(serverApplyFrameRef.current)
        serverApplyFrameRef.current = undefined
      }
      if (!isRowDataEdited && newHash !== dataHashRef.current) {
        try {
          runAsServerApply(() => api.updateGridOptions({
            rowData:
              parseData(
                componentData.data,
                asGridOptionsObject(componentData.gridOptions).rowData
              ) || []
          }))
          dataHashRef.current = newHash
        } catch (error) {
          console.error("Failed to update client-wins row data:", error)
        }
      }
      return
    }

    const outstanding = outstandingServerReturnRef.current
    if (outstanding) {
      if (componentData._server_sync_render_token !== outstanding.token) return

      const newerMutations = serverCellMutationsRef.current.filter(
        (mutation) =>
          mutation.generation > outstanding.submittedGeneration
      )
      if (newerMutations.some((mutation) => mutation.structural)) {
        releaseOutstandingServerReturn(false)
        return
      }
      const protectedFields = new Map<IRowNode, Set<string>>()
      for (const mutation of newerMutations) {
        if (!mutation.node || !mutation.field) continue
        const fields = protectedFields.get(mutation.node) ?? new Set<string>()
        fields.add(mutation.field)
        protectedFields.set(mutation.node, fields)
      }
      const result = applyAuthoritativeServerData(
        serverSyncStrategy,
        componentData,
        protectedFields,
        true
      )
      if (result !== "deferred") {
        releaseOutstandingServerReturn(result === "applied")
      }
      return
    }

    const latestUnqueued = latestUnqueuedServerReturnRef.current
    if (latestUnqueued) {
      if (
        componentData._server_sync_render_token !== latestUnqueued.token
      ) return

      const newerMutations = serverCellMutationsRef.current.filter(
        (mutation) =>
          mutation.generation > latestUnqueued.submittedGeneration
      )
      if (newerMutations.some((mutation) => mutation.structural)) {
        releaseOutstandingServerReturn(false)
        return
      }
      const protectedFields = new Map<IRowNode, Set<string>>()
      for (const mutation of newerMutations) {
        if (!mutation.node || !mutation.field) continue
        const fields = protectedFields.get(mutation.node) ?? new Set<string>()
        fields.add(mutation.field)
        protectedFields.set(mutation.node, fields)
      }
      const result = applyAuthoritativeServerData(
        serverSyncStrategy,
        componentData,
        protectedFields,
        true
      )
      if (result !== "deferred") {
        releaseOutstandingServerReturn(result === "applied")
      }
      return
    }

    const shouldApplyServerData =
      strategyChanged ||
      serverDataDirtyRef.current ||
      newHash !== dataHashRef.current
    if (!shouldApplyServerData) return

    applyAuthoritativeServerData(serverSyncStrategy)
  }, [
    applyAuthoritativeServerData,
    gridReadySequence,
    props.componentRenderSequence,
    releaseOutstandingServerReturn,
    runAsServerApply,
  ])

  // Effect 4: Handle column state changes only when its content changes.
  useEffect(() => {
    const api = apiRef.current
    const columnsState = latestComponentDataRef.current?.columns_state
    if (!api || !columnsState) return
    if (
      columnsStateInputSignature ===
      lastColumnsStateInputSignatureRef.current
    ) return

    latestDebugRef.current && console.log("********** Column state updated")
    api.applyColumnState({ state: columnsState, applyOrder: true })
    lastColumnsStateInputSignatureRef.current = columnsStateInputSignature
  }, [columnsStateInputSignature, gridReadySequence])

  const resizeGridContainer = useCallback(() => {
    const renderedGridHeight = gridContainerRef.current?.clientHeight
    if (
      renderedGridHeight &&
      renderedGridHeight > 0 &&
      renderedGridHeight !== renderedGridHeightPrevious.current
    ) {
      renderedGridHeightPrevious.current = renderedGridHeight
      if (props.parentElement instanceof HTMLElement) {
        props.parentElement.style.height = `${renderedGridHeight}px`
      }
    }
  }, [props.parentElement])

  const publishServerResponse = useCallback(
    (
      responseData: any,
      submittedGeneration: number,
      lockUntilServerRender: boolean
    ) => {
      const serverSyncStrategy = serverSyncStrategyRef.current
      const usesServerQueue =
        lockUntilServerRender &&
        serverSyncStrategy !== "client_wins" &&
        props.data?._server_sync_has_render_marker === true &&
        !isInsideStreamlitForm
      let renderToken: string | undefined
      if (props.data?._server_sync_has_render_marker === true) {
        renderToken =
          typeof window.crypto?.randomUUID === "function"
            ? window.crypto.randomUUID()
            : `${Date.now()}-${Math.random()}`
      }
      if (usesServerQueue && renderToken) {
        outstandingServerReturnRef.current = {
          token: renderToken,
          submittedGeneration,
        }
      } else if (
        serverSyncStrategy !== "client_wins" &&
        renderToken &&
        !isInsideStreamlitForm
      ) {
        // Returns without tracked cell mutations do not need serialization.
        // Only their newest marker matters when server renders overlap.
        latestUnqueuedServerReturnRef.current = {
          token: renderToken,
          submittedGeneration,
        }
      }

      props.setStateValue("grid_response", responseData)
      if (renderToken) props.setStateValue("_server_sync", renderToken)
    },
    [isInsideStreamlitForm, props]
  )

  const returnGridValue = useCallback(async (
    eventData: any,
    streamlitRerunEventTriggerName: string,
    returnOptions?: ReturnGridValueOptions,
    submittedGenerationOverride?: number
  ) => {
    const serverDataEditSequence =
      submittedGenerationOverride ?? serverDataEditSequenceRef.current
    if (debug) {
      console.log(`Refreshing grid from ${streamlitRerunEventTriggerName}, mode: ${props.data?.data_return_mode}`)
    }

    try {
      // Avoid expensive full-grid collection for intermediate events that the
      // user has explicitly chosen not to return.
      if (shouldGridReturnRef.current?.({ streamlitRerunEventTriggerName, eventData }) === false) {
        debug && console.log(`should_grid_return blocked return for event: ${streamlitRerunEventTriggerName}`)
        return
      }
    } catch (error) {
      console.error("Error evaluating should_grid_return:", error)
      return
    }

    const returnMode = props.data?.data_return_mode || "AS_INPUT"
    const usesServerQueue =
      serverSyncStrategyRef.current !== "client_wins" &&
      props.data?._server_sync_has_render_marker === true &&
      !isInsideStreamlitForm
    const enqueueServerReturn = (next: QueuedServerReturn) => {
      if (LEGACY_FULL_FRAME_RETURN_MODES.has(returnMode)) {
        // A legacy response is a complete frame, so the newest pending trigger
        // subsumes earlier ones. Exact CUSTOM/MINIMAL deltas must remain FIFO.
        queuedServerReturnsRef.current = [next]
      } else {
        queuedServerReturnsRef.current.push({
          ...next,
          submittedGeneration: serverDataEditSequence,
        })
      }
    }
    if (
      usesServerQueue &&
      outstandingServerReturnRef.current
    ) {
      // Collect only after the current authoritative render. This refreshes
      // legacy derived fields and prevents exact deltas from being coalesced by
      // consecutive component-state writes before Streamlit can rerun.
      enqueueServerReturn({
        eventData,
        triggerName: streamlitRerunEventTriggerName,
        returnOptions,
      })
      return
    }

    const returnSequence = ++returnSequenceRef.current
    const context: CollectorContext = {
      state: { gridOptions: gridOptionsRef.current, isRowDataEdited, api: apiRef.current, enterprise_features_enabled, debug, editedRows, isMaximized, savedColumnState, gridHeight: props.data?.height || 400 },
      props: {data: props.data},
      eventData,
      streamlitRerunEventTriggerName,
    }

    const customCollectorFunction = collectGridReturnRef.current
    const legacyCollector = new LegacyCollector()
    const collectors = {
      AS_INPUT: legacyCollector,
      FILTERED: legacyCollector,
      FILTERED_AND_SORTED: legacyCollector,
      MINIMAL: new MinimalCollector(),
      CUSTOM: customCollectorFunction
        ? new CustomCollector(customCollectorFunction)
        : undefined,
    }
    const collectorMode = returnMode as keyof typeof collectors
    if (collectorMode === "CUSTOM" && !collectors.CUSTOM) {
      console.error(
        "CUSTOM data_return_mode requires custom_jscode_for_grid_return. Grid response was not sent."
      )
      return
    }

    try {
      // The first return is collected immediately. Queued legacy snapshots and
      // exact deltas reach this point only after the prior server render.
      let collector = collectors[collectorMode] || collectors.AS_INPUT
      if (returnOptions?.bulkEditBatch && collectorMode !== "CUSTOM") {
        collector = new BulkEditBatchCollector(
          collectorMode === "MINIMAL" ? undefined : legacyCollector
        )
      }
      const result = await collector.processResponse(context)

      if (result.success) {
        debug && console.log(`Grid response processed by ${collector.getCollectorType()}:`, result.data)

        // Preserve the existing latest-result rule for asynchronous custom
        // collectors. Synchronous QP edit collectors resolve before the next
        // browser input task, so each immediate publish still reaches here.
        if (!isMountedRef.current || returnSequence !== returnSequenceRef.current) {
          debug && console.log(`Discarded stale grid response for event: ${streamlitRerunEventTriggerName}`)
          return
        }

        if (
          LEGACY_FULL_FRAME_RETURN_MODES.has(returnMode) &&
          Array.isArray(result.data?.nodes) &&
          withheldServerCellsRef.current.length > 0
        ) {
          // An open editor keeps its own buffered value while node.data stays
          // unchanged. A queued full-frame callback must nevertheless see the
          // latest authoritative server value for that untouched active cell.
          for (const correction of withheldServerCellsRef.current) {
            const returnedNode = result.data.nodes.find(
              (node: any) => String(node?.id) === String(correction.node.id)
            )
            if (returnedNode?.data && typeof returnedNode.data === "object") {
              returnedNode.data[correction.field] = cloneDeep(correction.value)
            }
          }
        }

        if (
          usesServerQueue &&
          outstandingServerReturnRef.current
        ) {
          enqueueServerReturn({
            eventData,
            triggerName: streamlitRerunEventTriggerName,
            returnOptions,
          })
        } else {
          publishServerResponse(
            result.data,
            serverDataEditSequence,
            usesServerQueue && serverDataDirtyRef.current
          )

          if (
            serverSyncStrategyRef.current !== "client_wins" &&
            props.data?._server_sync_has_render_marker !== true &&
            serverDataDirtyRef.current &&
            serverDataEditSequence === serverDataEditSequenceRef.current
          ) {
            // Unkeyed component state cannot echo the private marker. Retain
            // the historical local fallback for those grids only.
            applyAuthoritativeServerData(serverSyncStrategyRef.current)
          }
        }
      } else {
        console.error(`Collector processing failed: ${result.error}`)
      }
    } catch (error) {
      console.error("Error in returnGridValue collector processing:", error)
    }
  }, [
    applyAuthoritativeServerData,
    debug,
    editedRows,
    enterprise_features_enabled,
    isMaximized,
    isInsideStreamlitForm,
    isRowDataEdited,
    publishServerResponse,
    props,
    savedColumnState,
  ])

  returnGridValueRef.current = returnGridValue

  const detachConfiguredGridEvents = useCallback((gridApi: GridApi) => {
    const cleanups = eventListenerCleanupsRef.current.get(gridApi)
    cleanups?.forEach((cleanup) => cleanup())
    eventListenerCleanupsRef.current.delete(gridApi)
  }, [])

  const clearConfiguredGridEvents = useCallback(() => {
    eventListenerCleanupsRef.current.forEach((cleanups) =>
      cleanups.forEach((cleanup) => cleanup())
    )
    eventListenerCleanupsRef.current.clear()
  }, [])

  const attachMutationTracking = useCallback(
    (gridApi: GridApi): Array<() => void> => {
      const markGridDataChanged = (
        mutation?: Omit<ServerCellMutation, "generation">
      ) => {
        if (isApplyingServerDataRef.current) return

        if (serverSyncStrategyRef.current === "client_wins") {
          latestDebugRef.current && console.debug(
            "server_sync_strategy is 'client_wins' - Data edited on Grid. " +
            "Ignoring server updates."
          )
          const activeBatch = clipboardBatching
            ? activeBulkEditBatchesRef.current.get(gridApi)
            : undefined
          if (activeBatch) {
            activeBatch.editedRowIds.add(
              mutation?.node?.id ?? "__grid_data_mutation__"
            )
          } else {
            setEditedRows((previous) =>
              new Set(previous).add(
                mutation?.node?.id ?? "__grid_data_mutation__"
              )
            )
          }
        } else {
          serverDataDirtyRef.current = true
          serverDataEditSequenceRef.current += 1
          serverCellMutationsRef.current.push({
            generation: serverDataEditSequenceRef.current,
            node: mutation?.node,
            field: mutation?.field,
            structural: mutation?.structural ?? true,
          })
        }
      }

      const onCellValueChanged = (event: CellValueChangedEvent) => {
        if ((event as any).source === SERVER_SYNC_EVENT_SOURCE) return
        const field =
          event.colDef.field ?? event.column?.getColDef().field
        const rootField = field?.split(".")[0]
        if (rootField) {
          withheldServerCellsRef.current =
            withheldServerCellsRef.current.filter(
              (correction) =>
                correction.node !== event.node ||
                correction.field !== rootField
            )
        }
        markGridDataChanged({
          node: event.node,
          field: rootField,
          structural: !field || gridApi !== apiRef.current,
        })
        if (clipboardBatching) {
          const activeBatch = activeBulkEditBatchesRef.current.get(gridApi)
          if (activeBatch) {
            const isFirstChange = activeBatch.size === 0
            activeBatch.record(event)
            if (isFirstChange && activeBatch.size > 0) {
              // Invalidate both an in-flight collector and any configured
              // debounced event queued before this operation. Neither may
              // restore or overwrite the eventual authoritative batch return.
              returnSequenceRef.current += 1
              bulkEditGenerationRef.current.set(
                gridApi,
                (bulkEditGenerationRef.current.get(gridApi) ?? 0) + 1
              )
            }
          }
        }
      }
      const onRowDragEnd = (event: RowDragEndEvent) => {
        const rowsDrop = event.rowsDrop
        if (
          !rowsDrop?.rowDragManaged ||
          rowsDrop.allowed === false ||
          rowsDrop.moved === false
        ) return
        markGridDataChanged({ structural: true })
      }
      let rowDataUpdatedBeforeAsyncFlush = false
      const onRowDataUpdated = () => {
        if (isApplyingServerDataRef.current) return

        // A client-side async transaction synchronously emits rowDataUpdated
        // and then asyncTransactionsFlushed for the same batch. Count that as
        // one mutation so a return listener on rowDataUpdated does not become
        // stale before its collector promise resumes.
        rowDataUpdatedBeforeAsyncFlush = true
        queueMicrotask(() => {
          rowDataUpdatedBeforeAsyncFlush = false
        })
        markGridDataChanged({ structural: true })
      }
      const onAsyncTransactionsFlushed = () => {
        if (rowDataUpdatedBeforeAsyncFlush) {
          rowDataUpdatedBeforeAsyncFlush = false
          return
        }
        markGridDataChanged({ structural: true })
      }

      const onEditingStopped = () => retryDeferredServerApply()

      // Cell edits are not the only way browser-owned data can change. Managed
      // row dragging and client-side transactions must also make the next
      // Streamlit invocation reconcile against the authoritative snapshot.
      gridApi.addEventListener("cellValueChanged", onCellValueChanged)
      gridApi.addEventListener("rowDragEnd", onRowDragEnd)
      gridApi.addEventListener("rowDataUpdated", onRowDataUpdated)
      gridApi.addEventListener(
        "asyncTransactionsFlushed",
        onAsyncTransactionsFlushed
      )
      gridApi.addEventListener("cellEditingStopped", onEditingStopped)
      gridApi.addEventListener("rowEditingStopped", onEditingStopped)
      gridApi.addEventListener("batchEditingStopped", onEditingStopped)
      gridApi.addEventListener("bulkEditingStopped", onEditingStopped)
      return [() => {
        gridApi.removeEventListener("cellValueChanged", onCellValueChanged)
        gridApi.removeEventListener("rowDragEnd", onRowDragEnd)
        gridApi.removeEventListener("rowDataUpdated", onRowDataUpdated)
        gridApi.removeEventListener(
          "asyncTransactionsFlushed",
          onAsyncTransactionsFlushed
        )
        gridApi.removeEventListener("cellEditingStopped", onEditingStopped)
        gridApi.removeEventListener("rowEditingStopped", onEditingStopped)
        gridApi.removeEventListener("batchEditingStopped", onEditingStopped)
        gridApi.removeEventListener("bulkEditingStopped", onEditingStopped)
      }]
    },
    [clipboardBatching, retryDeferredServerApply]
  )

  const attachBulkEditBatching = useCallback(
    (gridApi: GridApi): Array<() => void> => {
      if (!clipboardBatching) return []

      const cleanups: Array<() => void> = []

      for (const [eventName, boundary] of Object.entries(BULK_EDIT_START_EVENTS)) {
        const handler = (event: any) => {
          const activeBatch = activeBulkEditBatchesRef.current.get(gridApi)
          if (activeBatch) {
            // Modern and deprecated delete boundaries can both be emitted for
            // the same operation. One buffer is sufficient for both aliases.
            if (activeBatch.operation !== boundary.operation) {
              console.warn(
                `Ignored nested ${boundary.operation} bulk edit while ` +
                `${activeBatch.operation} was active.`
              )
            }
            return
          }

          activeBulkEditBatchesRef.current.set(
            gridApi,
            new BulkEditBatch(
              boundary.operation,
              boundary.endEventName,
              gridApi,
              event
            )
          )
        }
        gridApi.addEventListener(eventName as any, handler as any)
        cleanups.push(() =>
          gridApi.removeEventListener(eventName as any, handler as any)
        )
      }

      for (const [eventName, boundary] of Object.entries(BULK_EDIT_END_EVENTS)) {
        const handler = (event: any) => {
          const batch = activeBulkEditBatchesRef.current.get(gridApi)
          if (!batch || batch.operation !== boundary.operation) return

          batch.endEvent = event
          if (batch.finalizeScheduled) return
          batch.finalizeScheduled = true

          // AG Grid emits all cellValueChanged events before the matching end
          // event. Finalising in a microtask also coalesces the modern and
          // deprecated range-delete end aliases when both are dispatched.
          queueMicrotask(() => {
            if (activeBulkEditBatchesRef.current.get(gridApi) !== batch) return
            activeBulkEditBatchesRef.current.delete(gridApi)

            if (batch.editedRowIds.size > 0) {
              setEditedRows((previous) => {
                const merged = new Set(previous)
                batch.editedRowIds.forEach((rowId) => merged.add(rowId))
                return merged
              })
            }

            if (batch.size === 0) {
              latestDebugRef.current && console.debug(
                `Skipped empty ${batch.operation} bulk edit batch.`
              )
              return
            }

            const cellChanges = batch.cellChanges()
            const lastCellChange = cellChanges[cellChanges.length - 1]
            const syntheticEvent = {
              ...batch.endEvent,
              api: gridApi,
              context:
                batch.endEvent?.context ??
                lastCellChange?.context ??
                gridOptionsRef.current?.context,
              type: batch.endEventName,
              bulkEditOperation: batch.operation,
              cellChanges,
            }
            void returnGridValueRef.current(
              syntheticEvent,
              batch.endEventName,
              { bulkEditBatch: true }
            )
          })
        }
        gridApi.addEventListener(eventName as any, handler as any)
        cleanups.push(() =>
          gridApi.removeEventListener(eventName as any, handler as any)
        )
      }

      cleanups.push(() => activeBulkEditBatchesRef.current.delete(gridApi))
      return cleanups
    },
    [clipboardBatching]
  )

  const attachStreamlitRerunToEvents = useCallback((gridApi: GridApi): Array<() => void> => {
    const cleanups: Array<() => void> = []

    updateOn.forEach((element: any) => {
      const [eventName, timeout] = Array.isArray(element) ? element : [element, 0]
      if (typeof eventName !== "string" || eventName.length === 0) return

      const debounceTimeout = Number(timeout)
      const shouldSuppressForBulkEdit = () =>
        clipboardBatching &&
        (
          BULK_EDIT_BOUNDARY_EVENTS.has(eventName) ||
          activeBulkEditBatchesRef.current.has(gridApi)
        )
      const invoke = ({
        event,
        bulkEditGeneration,
      }: {
        event: any
        bulkEditGeneration: number
      }) => {
        // Recheck at execution time as well as receipt time. A debounced event
        // may otherwise wake up after a bulk operation has started and race
        // its one authoritative end response.
        if (
          isApplyingServerDataRef.current ||
          shouldSuppressForBulkEdit() ||
          bulkEditGeneration !==
            (bulkEditGenerationRef.current.get(gridApi) ?? 0)
        ) return
        void returnGridValueRef.current(event, eventName)
      }
      const scheduledHandler = Number.isFinite(debounceTimeout) && debounceTimeout > 0
        ? debounce(invoke, debounceTimeout, {
            leading: false,
            trailing: true,
            maxWait: debounceTimeout,
        })
        : invoke
      const handler = (event: any) => {
        if (
          isApplyingServerDataRef.current ||
          event?.source === SERVER_SYNC_EVENT_SOURCE ||
          shouldSuppressForBulkEdit()
        ) return
        scheduledHandler({
          event,
          bulkEditGeneration:
            bulkEditGenerationRef.current.get(gridApi) ?? 0,
        })
      }

      // update_on is intentionally extensible, including enterprise events
      // not present in the community GridApi event type union.
      gridApi.addEventListener(eventName as any, handler as any)
      cleanups.push(() => {
        gridApi.removeEventListener(eventName as any, handler as any)
        const cancel = (scheduledHandler as { cancel?: () => void }).cancel
        if (typeof cancel === "function") {
          cancel()
        }
      })
      debug && console.log(`Attached grid return event: ${eventName}${debounceTimeout > 0 ? ` (debounced ${debounceTimeout}ms)` : ''}`)
    })

    return cleanups
  }, [clipboardBatching, updateOn, debug])

  const attachConfiguredGridEvents = useCallback((gridApi: GridApi) => {
    if (eventListenerCleanupsRef.current.has(gridApi)) return
    eventListenerCleanupsRef.current.set(
      gridApi,
      [
        ...attachMutationTracking(gridApi),
        ...attachBulkEditBatching(gridApi),
        ...attachStreamlitRerunToEvents(gridApi),
      ]
    )
  }, [
    attachBulkEditBatching,
    attachMutationTracking,
    attachStreamlitRerunToEvents,
  ])

  const syncDetailGridEvents = useCallback((masterGridApi: GridApi) => {
    const liveApis = new Set<GridApi>([masterGridApi])

    if (enterprise_features_enabled) {
      masterGridApi.forEachDetailGridInfo((info: DetailGridInfo) => {
        if (!info.api) return
        liveApis.add(info.api)
        attachConfiguredGridEvents(info.api)
      })
    }

    for (const configuredApi of eventListenerCleanupsRef.current.keys()) {
      if (!liveApis.has(configuredApi)) detachConfiguredGridEvents(configuredApi)
    }
  }, [
    attachConfiguredGridEvents,
    detachConfiguredGridEvents,
    enterprise_features_enabled,
  ])

  const syncDetailGridEventsRef = useRef(syncDetailGridEvents)
  syncDetailGridEventsRef.current = syncDetailGridEvents

  const bindConfiguredGridEvents = useCallback((gridApi: GridApi) => {
    clearConfiguredGridEvents()
    attachConfiguredGridEvents(gridApi)
    syncDetailGridEvents(gridApi)
  }, [
    attachConfiguredGridEvents,
    clearConfiguredGridEvents,
    syncDetailGridEvents,
  ])

  useEffect(() => {
    if (apiRef.current) bindConfiguredGridEvents(apiRef.current)
    return clearConfiguredGridEvents
  }, [bindConfiguredGridEvents, clearConfiguredGridEvents])

  const proReturnHandler = useCallback<ProReturnHandler>(
    (eventData, streamlitRerunEventTriggerName) =>
      returnGridValueRef.current(eventData, streamlitRerunEventTriggerName),
    []
  )

  // StreamlitAgGridPro historically calls one global hook. The registry keeps
  // that public hook while routing API-bearing events to the owning grid.
  useEffect(() => {
    const StreamlitAgGridPro = (window as any)?.StreamlitAgGridPro
    if (!StreamlitAgGridPro) return

    return registerProReturnHandler(
      StreamlitAgGridPro,
      proReturnOwnerRef.current,
      {
        handler: proReturnHandler,
        ownsApi: (api) =>
          apiRef.current === api || eventListenerCleanupsRef.current.has(api),
      }
    )
  }, [proAssetsSignature, proReturnHandler])

  const toggleMaximize = useCallback(() => {
    setIsMaximized(prev => {
      if (!prev) {
        setSavedColumnState(apiRef.current?.getColumnState())
        setTimeout(() => apiRef.current?.sizeColumnsToFit(), 0)
      } else if (savedColumnState) {
        setTimeout(() => apiRef.current?.applyColumnState({ state: savedColumnState, applyOrder: true }), 0)
      }
      return !prev
    })
  }, [savedColumnState])

  const onGridReady = useCallback((event: GridReadyEvent) => {
    apiRef.current = event.api
    gridLifecycleCleanupRef.current?.()

    // Attach resize listeners
    event.api.addEventListener("rowGroupOpened", resizeGridContainer)
    event.api.addEventListener("firstDataRendered", resizeGridContainer)
    event.api.addEventListener("gridSizeChanged", resizeGridContainer)

    let detailSyncTimeout: number | undefined
    let detailSyncFrame: number | undefined
    const runDetailGridSync = () => {
      if (!event.api.isDestroyed()) {
        syncDetailGridEventsRef.current(event.api)
      }
    }
    const scheduleDetailGridSync = () => {
      if (detailSyncTimeout !== undefined) window.clearTimeout(detailSyncTimeout)
      if (detailSyncFrame !== undefined) window.cancelAnimationFrame(detailSyncFrame)
      detailSyncTimeout = window.setTimeout(runDetailGridSync, 0)
      detailSyncFrame = window.requestAnimationFrame(runDetailGridSync)
    }

    // Detail grids register with the master just after expansion/rendering.
    // Scan after those lifecycle events so newly created and removed detail
    // APIs receive the same configured Streamlit listeners as the master.
    event.api.addEventListener("rowGroupOpened", scheduleDetailGridSync)
    event.api.addEventListener("modelUpdated", scheduleDetailGridSync)
    event.api.addEventListener("firstDataRendered", scheduleDetailGridSync)

    bindConfiguredGridEvents(event.api)
    scheduleDetailGridSync()

    gridLifecycleCleanupRef.current = () => {
      event.api.removeEventListener("rowGroupOpened", resizeGridContainer)
      event.api.removeEventListener("firstDataRendered", resizeGridContainer)
      event.api.removeEventListener("gridSizeChanged", resizeGridContainer)
      event.api.removeEventListener("rowGroupOpened", scheduleDetailGridSync)
      event.api.removeEventListener("modelUpdated", scheduleDetailGridSync)
      event.api.removeEventListener("firstDataRendered", scheduleDetailGridSync)
      if (detailSyncTimeout !== undefined) window.clearTimeout(detailSyncTimeout)
      if (detailSyncFrame !== undefined) window.cancelAnimationFrame(detailSyncFrame)
    }

    setGridReadySequence((sequence) => sequence + 1)
    // Call user's onGridReady if provided. The internal ready signal is set
    // first so an exception in user code cannot suppress pending prop updates.
    gridOptionsRef.current?.onGridReady?.(event)
  }, [bindConfiguredGridEvents, resizeGridContainer])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      returnSequenceRef.current += 1
      outstandingServerReturnRef.current = undefined
      latestUnqueuedServerReturnRef.current = undefined
      queuedServerReturnsRef.current = []
      serverCellMutationsRef.current = []
      withheldServerCellsRef.current = []
      deferredServerComponentDataRef.current = undefined
      deferredServerEditSequenceRef.current = undefined
      if (serverApplyFrameRef.current !== undefined) {
        window.cancelAnimationFrame(serverApplyFrameRef.current)
        serverApplyFrameRef.current = undefined
      }
      clearConfiguredGridEvents()
      gridLifecycleCleanupRef.current?.()
      gridLifecycleCleanupRef.current = undefined
      apiRef.current = undefined
    }
  }, [clearConfiguredGridEvents])

  const domLayout = rawGridOptions.domLayout
  const defineContainerHeight = useMemo(() => {
    if (isMaximized) {
      return {
        width: '100vw',
        height: '100vh',
      }
    } else if (domLayout === "autoHeight") {
      return {
        width: "100%",
      }
    } else {
      return {
        width: "100%",
        height: props.data?.height || 400,
      }
    }
  }, [domLayout, isMaximized, props.data?.height])

  const manualUpdate = props.data?.manual_update === true
  const showToolbar = props.data?.show_toolbar === true
  const customCss = props.data?.custom_css
    ? getCSS(props.data.custom_css)
    : ""
  const proCss = proAssets
    .map((asset: any) => asset?.css)
    .filter((css: unknown): css is string => typeof css === "string")
    .join("\n")
  const componentCss = [customCss, proCss].filter(Boolean).join("\n")

  return (
    <div
      id="gridContainer"
      ref={gridContainerRef}
      className={isMaximized ? 'maximized' : ''}
      style={defineContainerHeight}
    >
      {componentCss && (
        <style data-streamlit-aggrid-custom-css>{componentCss}</style>
      )}
      <GridToolBar
        showManualUpdateButton={manualUpdate}
        enabled={showToolbar || manualUpdate}
        showFullscreenButton={showToolbar}
        showSearch={showToolbar && (props.data?.show_search ?? true)}
        showDownloadButton={showToolbar && (props.data?.show_download_button ?? true)}
        isMaximized={isMaximized}
        onMaximizeToggle={toggleMaximize}
        onQuickSearchChange={(value) => {
          apiRef.current?.setGridOption("quickFilterText", value)
          apiRef.current?.hideOverlay()
        }}
        onDownloadClick={() => {
          apiRef.current?.exportDataAsCsv()
        }}
        onManualUpdateClick={() => {
          debug && console.log("Manual update triggered")
          returnGridValue({ api: apiRef.current }, "manualUpdate")
        }}
      />
      <AgGridReact
        onGridReady={onGridReady}
        gridOptions={gridOptions}
      ></AgGridReact>
    </div>
  )
}

const reactRoots: WeakMap<ComponentArgs<any, AgGridData>["parentElement"], Root> = new WeakMap()
const componentRenderSequences: WeakMap<
  ComponentArgs<any, AgGridData>["parentElement"],
  number
> = new WeakMap()
