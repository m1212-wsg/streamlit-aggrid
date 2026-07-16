from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

from e2e_utils import StreamlitRunner


pytestmark = pytest.mark.e2e

HERE = Path(__file__).parent.absolute()
APP_FILE = HERE / "grid_clipboard_batching.py"


@pytest.fixture(scope="function")
def streamlit_app():
    with StreamlitRunner(APP_FILE) as runner:
        yield runner
        runner.assert_running()


@pytest.fixture(autouse=True)
def go_to_app(page: Page, streamlit_app: StreamlitRunner):
    streamlit_app.assert_running()
    page.goto(streamlit_app.server_url)
    expect(page.get_by_role("img", name="Running...")).to_be_hidden()
    expect(page.locator(".st-key-custom_bulk_grid .ag-root")).to_be_visible()
    expect(page.locator(".st-key-legacy_bulk_grid .ag-root")).to_be_visible()
    expect(page.locator(".st-key-minimal_bulk_grid .ag-root")).to_be_visible()


def _dispatch_bulk_edit(
    page: Page,
    *,
    start_events: list[str],
    end_events: list[str],
    changes: list[tuple[str, object]],
    source: str,
    during_events: list[str] | None = None,
):
    page.evaluate(
        """
        ({startEvents, endEvents, changes, source, duringEvents}) => {
            const api = window.__bulkCustomApi;
            startEvents.forEach(type => api.dispatchEvent({type, source, api}));
            changes.forEach(([rowId, value]) => {
                api.getRowNode(rowId).setDataValue("amount", value, source);
            });
            duringEvents.forEach(type => {
                if (type === "filterChanged") {
                    // Use a real API action so AG Grid supplies the complete
                    // native event object expected by its internal listeners.
                    const current = api.getGridOption("quickFilterText");
                    api.setGridOption(
                        "quickFilterText",
                        current === "Alpha" ? "Bravo" : "Alpha"
                    );
                } else {
                    api.dispatchEvent({type, source, api});
                }
            });
            endEvents.forEach(type => api.dispatchEvent({type, source, api}));
        }
        """,
        {
            "startEvents": start_events,
            "endEvents": end_events,
            "changes": changes,
            "source": source,
            "duringEvents": during_events or [],
        },
    )


def test_single_edit_fast_path_and_paste_coalescing_are_preserved(page: Page):
    response = page.get_by_test_id("custom-bulk-response")
    expect(response).to_have_text("{}")

    # A normal single-cell event still calls the CUSTOM collector immediately.
    page.evaluate(
        "window.__bulkCustomApi.getRowNode('a').setDataValue('amount', 11, 'edit')"
    )
    expect(response).to_contain_text("singleCell")
    expect(response).to_contain_text("'calls': 1")
    expect(response).to_contain_text("'newValue': 11")
    expect(
        page.locator(
            ".st-key-custom_bulk_grid .ag-row[row-id='a'] [col-id='amount']"
        )
    ).to_have_text("10")

    page.evaluate("window.__bulkServerRestores = 0")
    # Queue a debounced configured return immediately before the batch. The
    # first actual changed cell invalidates it so it cannot overwrite the
    # batch payload or trigger an intermediate server-wins restoration.
    page.evaluate(
        "window.__bulkCustomApi.setGridOption('quickFilterText', 'Alpha')"
    )
    _dispatch_bulk_edit(
        page,
        start_events=["pasteStart"],
        end_events=["pasteEnd"],
        changes=[("a", 11), ("a", 12), ("b", 21)],
        source="paste",
        during_events=["filterChanged"],
    )

    expect(response).to_contain_text("cellBatch")
    expect(response).to_contain_text("'source': 'paste'")
    expect(response).to_contain_text("'trigger': 'pasteEnd'")
    expect(response).to_contain_text("'calls': 2")
    # The same cell appears once with the first old value and final new value.
    assert (
        page.get_by_test_id("custom-bulk-response").inner_text().count("'rowId': 'a'")
        == 1
    )
    expect(response).to_contain_text("'oldValue': 10")
    expect(response).to_contain_text("'newValue': 12")
    expect(response).to_contain_text("'rowId': 'b'")
    expect(response).to_contain_text("'dataRevision': 'revision-7'")
    # server_wins restores only after the one batch response, never per cell.
    page.wait_for_function("window.__bulkServerRestores === 1")
    assert page.evaluate("window.__bulkServerRestores") == 1
    page.wait_for_timeout(350)
    assert page.evaluate("window.__bulkCollectorCalls") == 2
    expect(response).to_contain_text("cellBatch")


def test_dual_delete_boundaries_are_one_batch_and_empty_batches_are_silent(
    page: Page,
):
    response = page.get_by_test_id("custom-bulk-response")

    _dispatch_bulk_edit(
        page,
        start_events=["cellSelectionDeleteStart", "rangeDeleteStart"],
        end_events=["cellSelectionDeleteEnd", "rangeDeleteEnd"],
        changes=[("a", None)],
        source="deleteKey",
    )
    expect(response).to_contain_text("'source': 'delete'")
    expect(response).to_contain_text("'trigger': 'cellSelectionDeleteEnd'")
    expect(response).to_contain_text("'calls': 1")
    assert (
        page.get_by_test_id("custom-bulk-response").inner_text().count("'rowId': 'a'")
        == 1
    )

    # No editable value changed: no collector call and no new state response.
    before = response.inner_text()
    _dispatch_bulk_edit(
        page,
        start_events=["pasteStart"],
        end_events=["pasteEnd"],
        changes=[],
        source="paste",
    )
    page.wait_for_timeout(250)
    assert response.inner_text() == before
    assert page.evaluate("window.__bulkCollectorCalls") == 1


def test_cut_and_fill_use_the_same_single_return_primitive(page: Page):
    response = page.get_by_test_id("custom-bulk-response")

    for expected_call, operation, start, end, value in [
        (1, "cut", "cutStart", "cutEnd", None),
        (2, "fill", "fillStart", "fillEnd", 15),
    ]:
        _dispatch_bulk_edit(
            page,
            start_events=[start],
            end_events=[end],
            changes=[("a", value)],
            source=operation,
        )
        expect(response).to_contain_text(f"'source': '{operation}'")
        expect(response).to_contain_text(f"'calls': {expected_call}")


def test_legacy_mode_keeps_data_shape_and_attaches_batch_metadata(page: Page):
    page.evaluate(
        """
        () => {
            const api = window.__bulkLegacyApi;
            api.dispatchEvent({type: "pasteStart", source: "paste", api});
            api.getRowNode("a").setDataValue("amount", 13, "paste");
            api.dispatchEvent({type: "pasteEnd", source: "paste", api});
        }
        """
    )

    data = page.get_by_test_id("legacy-bulk-data")
    metadata = page.get_by_test_id("legacy-bulk-metadata")
    expect(data).to_contain_text("'id': 'a'")
    expect(data).to_contain_text("'amount': 13")
    expect(metadata).to_contain_text("'operation': 'paste'")
    expect(metadata).to_contain_text("'columnId': 'amount'")
    expect(metadata).to_contain_text("'oldValue': 10")
    expect(metadata).to_contain_text("'newValue': 13")


def test_minimal_batch_preserves_bigint_precision_as_a_string(page: Page):
    page.evaluate(
        """
        () => {
            const api = window.__bulkMinimalApi;
            const node = api.getRowNode("a");
            const column = api.getColumn("amount");
            const value = 900719925474099312345n;
            api.dispatchEvent({type: "pasteStart", source: "paste", api});
            // AG Grid cell values normally originate in JSON/Arrow and cannot
            // themselves be bigint. A complete native-like change event
            // isolates the compact collector's precision guarantee.
            api.dispatchEvent({
                type: "cellValueChanged",
                source: "paste",
                api,
                context: api.getGridOption("context"),
                node,
                data: node.data,
                rowIndex: node.rowIndex,
                rowPinned: node.rowPinned,
                column,
                colDef: column.getColDef(),
                oldValue: 10,
                newValue: value,
                newRawValue: value,
                value
            });
            api.dispatchEvent({type: "pasteEnd", source: "paste", api});
        }
        """
    )

    metadata = page.get_by_test_id("minimal-bulk-metadata")
    expect(metadata).to_contain_text("'oldValue': 10")
    expect(metadata).to_contain_text("'newValue': '900719925474099312345'")
