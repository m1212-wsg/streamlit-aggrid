import pandas as pd
import streamlit as st

from st_aggrid import AgGrid, DataReturnMode, JsCode


ROWS = [
    {"id": "a", "label": "Alpha", "amount": 10},
    {"id": "b", "label": "Bravo", "amount": 20},
]


CUSTOM_BATCH_COLLECTOR = JsCode(
    """
    function({eventData}) {
        window.__bulkCollectorCalls = (window.__bulkCollectorCalls || 0) + 1;

        function project(change) {
            return {
                field: change.colDef && change.colDef.field
                    ? change.colDef.field
                    : change.column.getColId(),
                rowId: change.node ? change.node.id : null,
                rowIndex: change.node ? change.node.rowIndex : null,
                rowData: {
                    id: change.data.id,
                    label: change.data.label,
                    amount: change.data.amount
                },
                oldValue: change.oldValue,
                newValue: change.newValue,
                dataRevision: change.context.dataRevision
            };
        }

        if (Array.isArray(eventData.cellChanges)) {
            return {
                kind: "cellBatch",
                source: eventData.bulkEditOperation,
                trigger: eventData.type,
                calls: window.__bulkCollectorCalls,
                changes: eventData.cellChanges.map(project)
            };
        }

        return {
            kind: "singleCell",
            calls: window.__bulkCollectorCalls,
            change: project(eventData)
        };
    }
    """
)


custom_options = {
    "columnDefs": [
        {"field": "id"},
        {"field": "label"},
        {"field": "amount", "editable": True},
    ],
    "getRowId": JsCode("params => String(params.data.id)"),
    "context": {"dataRevision": "revision-7"},
    "onGridReady": JsCode(
        """
        function(params) {
            window.__bulkCustomApi = params.api;
            window.__bulkServerRestores = 0;
            const updateGridOptions = params.api.updateGridOptions.bind(params.api);
            params.api.updateGridOptions = function(options) {
                if (options && options.rowData) window.__bulkServerRestores += 1;
                return updateGridOptions(options);
            };
        }
        """
    ),
}

custom_response = AgGrid(
    pd.DataFrame(ROWS),
    gridOptions=custom_options,
    key="custom_bulk_grid",
    allow_unsafe_jscode=True,
    enable_enterprise_modules="enterpriseOnly",
    data_return_mode=DataReturnMode.CUSTOM,
    custom_jscode_for_grid_return=CUSTOM_BATCH_COLLECTOR,
    update_on=[
        "cellValueChanged",
        ("filterChanged", 250),
        "selectionChanged",
        "sortChanged",
        "pasteStart",
        "pasteEnd",
        "cutStart",
        "cutEnd",
        "cellSelectionDeleteStart",
        "cellSelectionDeleteEnd",
        "rangeDeleteStart",
        "rangeDeleteEnd",
        "fillStart",
        "fillEnd",
    ],
    clipboard_batching=True,
    server_sync_strategy="server_wins",
)

st.html(
    "<pre data-testid='custom-bulk-response'>"
    f"{custom_response.grid_response!r}</pre>"
)


legacy_response = AgGrid(
    pd.DataFrame(ROWS),
    gridOptions={
        "columnDefs": [
            {"field": "id"},
            {"field": "label"},
            {"field": "amount", "editable": True},
        ],
        "getRowId": JsCode("params => String(params.data.id)"),
        "onGridReady": JsCode("params => { window.__bulkLegacyApi = params.api; }"),
    },
    key="legacy_bulk_grid",
    allow_unsafe_jscode=True,
    enable_enterprise_modules="enterpriseOnly",
    data_return_mode=DataReturnMode.AS_INPUT,
    update_on=["cellValueChanged"],
    clipboard_batching=True,
)

st.html(
    "<pre data-testid='legacy-bulk-data'>"
    f"{legacy_response.data.to_dict('records') if legacy_response.data is not None else None!r}"
    "</pre>"
)
st.html(
    "<pre data-testid='legacy-bulk-metadata'>"
    f"{legacy_response.clipboard_batch!r}</pre>"
)


minimal_response = AgGrid(
    pd.DataFrame(ROWS),
    gridOptions={
        "columnDefs": [
            {"field": "id"},
            {"field": "label"},
            {"field": "amount", "editable": True},
        ],
        "getRowId": JsCode("params => String(params.data.id)"),
        "onGridReady": JsCode("params => { window.__bulkMinimalApi = params.api; }"),
    },
    key="minimal_bulk_grid",
    allow_unsafe_jscode=True,
    enable_enterprise_modules="enterpriseOnly",
    data_return_mode=DataReturnMode.MINIMAL,
    update_on=["cellValueChanged"],
    clipboard_batching=True,
)

st.html(
    "<pre data-testid='minimal-bulk-metadata'>"
    f"{minimal_response.clipboard_batch!r}</pre>"
)
