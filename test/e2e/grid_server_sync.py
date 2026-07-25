import time

import pandas as pd
import streamlit as st

from st_aggrid import AgGrid, DataReturnMode, JsCode


INITIAL_ROWS = [
    {"id": "a", "value": "alpha", "revision": 1},
    {"id": "b", "value": "bravo", "revision": 1},
    {"id": "c", "value": "charlie", "revision": 1},
]

UPDATED_ROWS = [
    {"id": "a", "value": "alpha", "revision": 1},
    {"id": "b", "value": "bravo-server", "revision": 2},
    {"id": "d", "value": "delta", "revision": 1},
]

CALLBACK_ROWS = [
    {"id": "a", "value": "alpha", "revision": 1},
    {"id": "b", "value": "bravo", "revision": 1},
]
QP_V1_ROWS = [{"id": "single", "RR": 10.0, "W1": 10.0, "W2": 10.0}]
QP_V2_ROWS = [
    {"id": "single", "Total": 20.0, "RR": 10.0, "W1": 10.0, "W2": 10.0}
]
QP_V1_STATE = "qp_v1_server_wins_rows"
QP_V2_STATE = "qp_v2_server_wins_rows"
FORM_STATE = "server_wins_form_rows"
NON_DATA_EVENT_STATE = "server_wins_non_data_event_rows"

# Keep the callback in flight long enough for Playwright to observe whether the
# frontend restores the previous server snapshot before Streamlit rerenders.
CALLBACK_DELAY_SECONDS = 0.75

ACCEPTED_GRID_STATES = {
    "server_wins_callback_grid": "server_wins_callback_rows",
    "server_wins_rows_callback_grid": "server_wins_rows_callback_rows",
}
REJECTED_GRID_STATES = {
    "server_wins_reject_grid": "server_wins_reject_rows",
    "server_wins_rows_reject_grid": "server_wins_rows_reject_rows",
}
DERIVED_GRID_STATES = {
    "server_wins_derived_grid": "server_wins_derived_rows",
    "server_wins_rows_derived_grid": "server_wins_rows_derived_rows",
}


if "server_rows" not in st.session_state:
    st.session_state.server_rows = INITIAL_ROWS
if "runtime_pagination" not in st.session_state:
    st.session_state.runtime_pagination = True
for state_key in [
    *ACCEPTED_GRID_STATES.values(),
    *REJECTED_GRID_STATES.values(),
    *DERIVED_GRID_STATES.values(),
    NON_DATA_EVENT_STATE,
]:
    if state_key not in st.session_state:
        st.session_state[state_key] = [row.copy() for row in CALLBACK_ROWS]
    count_key = f"{state_key}_callback_count"
    if count_key not in st.session_state:
        st.session_state[count_key] = 0
if QP_V1_STATE not in st.session_state:
    st.session_state[QP_V1_STATE] = [row.copy() for row in QP_V1_ROWS]
if f"{QP_V1_STATE}_callback_count" not in st.session_state:
    st.session_state[f"{QP_V1_STATE}_callback_count"] = 0
if QP_V2_STATE not in st.session_state:
    st.session_state[QP_V2_STATE] = [row.copy() for row in QP_V2_ROWS]
if f"{QP_V2_STATE}_callback_count" not in st.session_state:
    st.session_state[f"{QP_V2_STATE}_callback_count"] = 0
if f"{QP_V2_STATE}_callback_order" not in st.session_state:
    st.session_state[f"{QP_V2_STATE}_callback_order"] = []
if FORM_STATE not in st.session_state:
    st.session_state[FORM_STATE] = [row.copy() for row in CALLBACK_ROWS]
if f"{FORM_STATE}_callback_count" not in st.session_state:
    st.session_state[f"{FORM_STATE}_callback_count"] = 0
if f"{FORM_STATE}_returned_values" not in st.session_state:
    st.session_state[f"{FORM_STATE}_returned_values"] = ""


def _accept_callback(response, state_key):
    time.sleep(CALLBACK_DELAY_SECONDS)
    returned = response.data
    if isinstance(returned, pd.DataFrame):
        st.session_state[state_key] = returned[
            ["id", "value", "revision"]
        ].to_dict("records")
    st.session_state[f"{state_key}_callback_count"] += 1


def _reject_callback(_response, state_key):
    time.sleep(CALLBACK_DELAY_SECONDS)
    st.session_state[f"{state_key}_callback_count"] += 1


def _accept_with_derived_callback(response, state_key):
    time.sleep(CALLBACK_DELAY_SECONDS)
    returned = response.data
    if isinstance(returned, pd.DataFrame):
        rows = returned[["id", "value", "revision"]].to_dict("records")
        for row in rows:
            row["revision"] = 2 if str(row["value"]).endswith("-derived") else 1
        st.session_state[state_key] = rows
    st.session_state[f"{state_key}_callback_count"] += 1


def accept_server_wins_callback(response):
    _accept_callback(response, ACCEPTED_GRID_STATES["server_wins_callback_grid"])


def accept_server_wins_rows_callback(response):
    _accept_callback(
        response,
        ACCEPTED_GRID_STATES["server_wins_rows_callback_grid"],
    )


def reject_server_wins_callback(response):
    _reject_callback(response, REJECTED_GRID_STATES["server_wins_reject_grid"])


def reject_server_wins_rows_callback(response):
    _reject_callback(
        response,
        REJECTED_GRID_STATES["server_wins_rows_reject_grid"],
    )


def accept_server_wins_derived_callback(response):
    _accept_with_derived_callback(
        response,
        DERIVED_GRID_STATES["server_wins_derived_grid"],
    )


def accept_server_wins_rows_derived_callback(response):
    _accept_with_derived_callback(
        response,
        DERIVED_GRID_STATES["server_wins_rows_derived_grid"],
    )


def accept_qp_v1_callback(response):
    """Model V1 semantics: RR edits redistribute; week edits recalculate RR."""
    time.sleep(CALLBACK_DELAY_SECONDS)
    returned = response.data
    if isinstance(returned, pd.DataFrame) and not returned.empty:
        old = st.session_state[QP_V1_STATE][0]
        row = returned[["id", "RR", "W1", "W2"]].iloc[0].to_dict()
        rr_changed = abs(float(row["RR"]) - float(old["RR"])) > 1e-6
        if rr_changed:
            # This mirrors the QP V1 promotion branch: an apparent RR change
            # wins over weekly values and redistributes from RR.
            row["W1"] = float(row["RR"])
            row["W2"] = float(row["RR"])
        else:
            row["W1"] = float(row["W1"])
            row["W2"] = float(row["W2"])
            row["RR"] = (row["W1"] + row["W2"]) / 2.0
        st.session_state[QP_V1_STATE] = [row]
    st.session_state[f"{QP_V1_STATE}_callback_count"] += 1


def accept_non_data_event_callback(response):
    _accept_callback(response, NON_DATA_EVENT_STATE)


def accept_qp_v2_callback(response):
    """Apply the compact per-cell shape used by QP V2 Model Single."""
    time.sleep(CALLBACK_DELAY_SECONDS)
    payload = response.raw_data
    if isinstance(payload, dict):
        row_id = str(payload.get("rowId", ""))
        field = str(payload.get("field", ""))
        for row in st.session_state[QP_V2_STATE]:
            if str(row["id"]) != row_id or field not in {"RR", "W1", "W2"}:
                continue
            if abs(float(row[field]) - float(payload.get("oldValue"))) > 1e-6:
                break
            row[field] = float(payload.get("newValue"))
            if field == "RR":
                row["W1"] = row["RR"]
                row["W2"] = row["RR"]
            else:
                row["RR"] = (row["W1"] + row["W2"]) / 2.0
            row["Total"] = row["W1"] + row["W2"]
            st.session_state[f"{QP_V2_STATE}_callback_order"].append(field)
            break
    st.session_state[f"{QP_V2_STATE}_callback_count"] += 1


def reject_form_callback(response):
    time.sleep(CALLBACK_DELAY_SECONDS)
    returned = response.data
    if isinstance(returned, pd.DataFrame):
        st.session_state[f"{FORM_STATE}_returned_values"] = "|".join(
            str(value) for value in returned["value"]
        )
    st.session_state[f"{FORM_STATE}_callback_count"] += 1


if st.button("Apply server row changes"):
    st.session_state.server_rows = UPDATED_ROWS

if st.button("Reorder server rows"):
    by_id = {row["id"]: row for row in st.session_state.server_rows}
    if set(by_id) == {"a", "b", "d"}:
        st.session_state.server_rows = [by_id["b"], by_id["a"], by_id["d"]]

if st.button("Toggle runtime pagination"):
    st.session_state.runtime_pagination = not st.session_state.runtime_pagination


row_options = {
    "columnDefs": [
        {"field": "id"},
        {
            "field": "value",
            "editable": True,
            "valueGetter": JsCode(
                """
                function(params) {
                    window.__serverWinsRowsEvaluations ??= {};
                    window.__serverWinsRowsObjects ??= {};
                    window.__serverWinsRowsObjectChanges ??= {};
                    const id = params.data.id;
                    window.__serverWinsRowsEvaluations[id] =
                        (window.__serverWinsRowsEvaluations[id] || 0) + 1;
                    if (id in window.__serverWinsRowsObjects &&
                        window.__serverWinsRowsObjects[id] !== params.data) {
                        window.__serverWinsRowsObjectChanges[id] =
                            (window.__serverWinsRowsObjectChanges[id] || 0) + 1;
                    }
                    window.__serverWinsRowsObjects[id] = params.data;
                    return params.data.value;
                }
                """
            ),
            "valueSetter": JsCode(
                "params => { params.data.value = params.newValue; return true; }"
            ),
        },
        {"field": "revision"},
    ],
    "getRowId": JsCode("params => String(params.data.id)"),
    "onGridReady": JsCode(
        """
        function(params) {
            window.__serverWinsRowsApi = params.api;
            window.__serverWinsRowsOptionUpdates = [];
            const updateGridOptions = params.api.updateGridOptions.bind(params.api);
            params.api.updateGridOptions = function(options) {
                window.__serverWinsRowsOptionUpdates.push(Object.keys(options));
                return updateGridOptions(options);
            };
        }
        """
    ),
    "animateRows": False,
}

AgGrid(
    pd.DataFrame(st.session_state.server_rows),
    gridOptions=row_options,
    key="server_wins_rows_grid",
    # Give the transaction regression a harmless component-prop change on the
    # pagination rerun. Components V2 intentionally skips byte-identical
    # component invocations.
    height=400 if st.session_state.runtime_pagination else 401,
    allow_unsafe_jscode=True,
    data_return_mode=DataReturnMode.MINIMAL,
    update_on=["cellValueChanged"],
    use_json_serialization=True,
    server_sync_strategy="server_wins_rows",
)

# Exercise the regular server-authoritative path alongside row reconciliation.
AgGrid(
    pd.DataFrame(st.session_state.server_rows),
    key="server_wins_grid",
    use_json_serialization=True,
    server_sync_strategy="server_wins",
)

AgGrid(
    gridOptions={
        "columnDefs": [{"field": "id"}, {"field": "value"}],
        "rowData": [{"id": "json-row", "value": "from-grid-options"}],
    },
    key="json_row_data_grid",
    use_json_serialization=True,
)

runtime_options = {
    "columnDefs": [{"field": "id"}, {"field": "value"}],
    "paginationPageSize": 2,
}
if st.session_state.runtime_pagination:
    runtime_options["pagination"] = True

AgGrid(
    pd.DataFrame(INITIAL_ROWS),
    gridOptions=runtime_options,
    key="runtime_options_grid",
    server_sync_strategy="server_wins",
)


callback_grid_options = {
    "columnDefs": [
        {"field": "id"},
        {"field": "value", "editable": True},
        {"field": "revision"},
    ],
    "getRowId": JsCode("params => String(params.data.id)"),
    "animateRows": False,
}

callback_grids = [
    (
        "server_wins_callback_grid",
        "server_wins",
        ACCEPTED_GRID_STATES["server_wins_callback_grid"],
        accept_server_wins_callback,
    ),
    (
        "server_wins_rows_callback_grid",
        "server_wins_rows",
        ACCEPTED_GRID_STATES["server_wins_rows_callback_grid"],
        accept_server_wins_rows_callback,
    ),
    (
        "server_wins_reject_grid",
        "server_wins",
        REJECTED_GRID_STATES["server_wins_reject_grid"],
        reject_server_wins_callback,
    ),
    (
        "server_wins_rows_reject_grid",
        "server_wins_rows",
        REJECTED_GRID_STATES["server_wins_rows_reject_grid"],
        reject_server_wins_rows_callback,
    ),
    (
        "server_wins_derived_grid",
        "server_wins",
        DERIVED_GRID_STATES["server_wins_derived_grid"],
        accept_server_wins_derived_callback,
    ),
    (
        "server_wins_rows_derived_grid",
        "server_wins_rows",
        DERIVED_GRID_STATES["server_wins_rows_derived_grid"],
        accept_server_wins_rows_derived_callback,
    ),
]

for grid_key, strategy, state_key, grid_callback in callback_grids:
    AgGrid(
        pd.DataFrame(st.session_state[state_key]),
        gridOptions=callback_grid_options,
        key=grid_key,
        height=140,
        allow_unsafe_jscode=True,
        data_return_mode=DataReturnMode.AS_INPUT,
        update_on=["cellValueChanged"],
        callback=grid_callback,
        use_json_serialization=True,
        server_sync_strategy=strategy,
    )
    st.html(
        f'<span data-testid="{grid_key}-callback-count">'
        f'{st.session_state[f"{state_key}_callback_count"]}</span>'
    )
    server_values = "|".join(
        str(row["value"]) for row in st.session_state[state_key]
    )
    st.html(
        f'<span data-testid="{grid_key}-server-values">'
        f"{server_values}</span>"
    )
    server_revisions = "|".join(
        str(row["revision"]) for row in st.session_state[state_key]
    )
    st.html(
        f'<span data-testid="{grid_key}-server-revisions">'
        f"{server_revisions}</span>"
    )
    component_state = st.session_state.get(grid_key, {})
    sync_token = (
        component_state.get("_server_sync", "")
        if hasattr(component_state, "get")
        else ""
    )
    st.html(
        f'<span data-testid="{grid_key}-sync-token">{sync_token}</span>'
    )


AgGrid(
    pd.DataFrame(st.session_state[NON_DATA_EVENT_STATE]),
    gridOptions={
        **callback_grid_options,
        "rowSelection": {"mode": "singleRow", "checkboxes": True},
    },
    key="server_wins_non_data_event_grid",
    height=140,
    allow_unsafe_jscode=True,
    data_return_mode=DataReturnMode.AS_INPUT,
    update_on=["selectionChanged", "cellValueChanged"],
    callback=accept_non_data_event_callback,
    use_json_serialization=True,
    server_sync_strategy="server_wins",
)
st.html(
    '<span data-testid="server-wins-non-data-callback-count">'
    f'{st.session_state[f"{NON_DATA_EVENT_STATE}_callback_count"]}</span>'
)
non_data_event_values = "|".join(
    str(row["value"]) for row in st.session_state[NON_DATA_EVENT_STATE]
)
st.html(
    '<span data-testid="server-wins-non-data-server-values">'
    f"{non_data_event_values}</span>"
)


AgGrid(
    pd.DataFrame(st.session_state[QP_V1_STATE]),
    gridOptions={
        "columnDefs": [
            {"field": "id"},
            {"field": "RR", "editable": True},
            {"field": "W1", "editable": True},
            {"field": "W2", "editable": True},
        ],
        "getRowId": JsCode("params => String(params.data.id)"),
        "animateRows": False,
    },
    key="qp_v1_server_wins_grid",
    height=120,
    allow_unsafe_jscode=True,
    data_return_mode=DataReturnMode.AS_INPUT,
    update_on=["cellValueChanged"],
    callback=accept_qp_v1_callback,
    use_json_serialization=True,
    server_sync_strategy="server_wins",
)
st.html(
    '<span data-testid="qp-v1-callback-count">'
    f'{st.session_state[f"{QP_V1_STATE}_callback_count"]}</span>'
)
qp_v1_row = st.session_state[QP_V1_STATE][0]
st.html(
    '<span data-testid="qp-v1-server-values">'
    f'{float(qp_v1_row["RR"]):.1f}|{float(qp_v1_row["W1"]):.1f}|'
    f'{float(qp_v1_row["W2"]):.1f}</span>'
)


AgGrid(
    pd.DataFrame(st.session_state[QP_V2_STATE]),
    gridOptions={
        "columnDefs": [
            {"field": "id"},
            {"field": "Total"},
            {"field": "RR", "editable": True},
            {"field": "W1", "editable": True},
            {"field": "W2", "editable": True},
        ],
        "getRowId": JsCode("params => String(params.data.id)"),
        "animateRows": False,
    },
    key="qp_v2_server_wins_rows_grid",
    height=140,
    allow_unsafe_jscode=True,
    data_return_mode=DataReturnMode.CUSTOM,
    custom_jscode_for_grid_return=JsCode(
        """
        function({eventData}) {
            return {
                rowId: String(eventData.data.id),
                field: eventData.colDef.field,
                rowData: {
                    id: eventData.data.id,
                    [eventData.colDef.field]: eventData.data[eventData.colDef.field]
                },
                newValue: eventData.newValue,
                oldValue: eventData.oldValue,
                dataRevision: null
            };
        }
        """
    ),
    update_on=["cellValueChanged"],
    callback=accept_qp_v2_callback,
    use_json_serialization=True,
    server_sync_strategy="server_wins_rows",
)
st.html(
    '<span data-testid="qp-v2-callback-count">'
    f'{st.session_state[f"{QP_V2_STATE}_callback_count"]}</span>'
)
qp_v2_row = st.session_state[QP_V2_STATE][0]
st.html(
    '<span data-testid="qp-v2-server-values">'
    f'{float(qp_v2_row["Total"]):.1f}|{float(qp_v2_row["RR"]):.1f}|'
    f'{float(qp_v2_row["W1"]):.1f}|'
    f'{float(qp_v2_row["W2"]):.1f}</span>'
)
qp_v2_order = "|".join(
    st.session_state[f"{QP_V2_STATE}_callback_order"]
)
st.html(
    f'<span data-testid="qp-v2-callback-order">{qp_v2_order}</span>'
)


with st.form("server_sync_form"):
    AgGrid(
        pd.DataFrame(st.session_state[FORM_STATE]),
        gridOptions=callback_grid_options,
        key="server_wins_form_grid",
        height=140,
        allow_unsafe_jscode=True,
        data_return_mode=DataReturnMode.AS_INPUT,
        update_on=["cellValueChanged"],
        callback=reject_form_callback,
        use_json_serialization=True,
        server_sync_strategy="server_wins",
    )
    st.form_submit_button("Submit server grid")

st.html(
    '<span data-testid="server-wins-form-callback-count">'
    f'{st.session_state[f"{FORM_STATE}_callback_count"]}</span>'
)
form_values = "|".join(str(row["value"]) for row in st.session_state[FORM_STATE])
st.html(
    f'<span data-testid="server-wins-form-server-values">{form_values}</span>'
)
st.html(
    '<span data-testid="server-wins-form-returned-values">'
    f'{st.session_state[f"{FORM_STATE}_returned_values"]}</span>'
)
form_component_state = st.session_state.get("server_wins_form_grid", {})
form_sync_token = (
    form_component_state.get("_server_sync", "")
    if hasattr(form_component_state, "get")
    else ""
)
st.html(
    f'<span data-testid="server-wins-form-sync-token">{form_sync_token}</span>'
)
