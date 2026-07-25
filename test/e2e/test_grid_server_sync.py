from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest
from playwright.sync_api import Page, expect

from e2e_utils import StreamlitRunner


pytestmark = pytest.mark.e2e

HERE = Path(__file__).parent.absolute()
SERVER_SYNC_FILE = HERE / "grid_server_sync.py"


@pytest.fixture(scope="function")
def streamlit_app():
    with StreamlitRunner(SERVER_SYNC_FILE) as runner:
        yield runner
        runner.assert_running()


@pytest.fixture(scope="function")
def outer_iframe_url(streamlit_app: StreamlitRunner):
    """Serve a real outer page on a second localhost origin."""
    document = (
        "<!doctype html><html><body>"
        f'<iframe id="streamlit-app" src="{streamlit_app.server_url}/?embed=true" '
        'style="width: 1200px; height: 900px"></iframe>'
        "</body></html>"
    ).encode()

    class OuterPageHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(document)))
            self.end_headers()
            self.wfile.write(document)

        def log_message(self, _format, *args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), OuterPageHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://localhost:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture(autouse=True)
def go_to_app(page: Page, streamlit_app: StreamlitRunner):
    streamlit_app.assert_running()
    page.goto(streamlit_app.server_url)
    expect(page.get_by_role("img", name="Running...")).to_be_hidden()


def _row(grid, row_id: str):
    return grid.locator(f".ag-row[row-id='{row_id}']")


def _value_cell(grid, row_id: str):
    return _row(grid, row_id).locator(".ag-cell[col-id='value']")


def _revision_cell(grid, row_id: str):
    return _row(grid, row_id).locator(".ag-cell[col-id='revision']")


def _object_change_count(page: Page, row_id: str) -> int:
    return page.evaluate(
        "rowId => window.__serverWinsRowsObjectChanges?.[rowId] || 0", row_id
    )


@pytest.mark.parametrize(
    "grid_key",
    [
        "server_wins_callback_grid",
        "server_wins_rows_callback_grid",
    ],
)
def test_accepted_callback_edit_stays_visible_until_server_rerender(
    page: Page, grid_key: str
):
    grid = page.locator(f".st-key-{grid_key}")
    alpha = _value_cell(grid, "a")
    expect(grid.locator(".ag-root")).to_be_visible()
    expect(alpha).to_have_text("alpha")

    alpha.dblclick()
    editor = alpha.locator("input")
    expect(editor).to_be_visible()
    editor.fill("alpha-accepted")
    editor.press("Enter")

    # The callback deliberately takes longer than this observation window.
    # Server-authoritative data should be applied by the resulting component
    # rerender, not immediately after the browser submits the edit response.
    page.wait_for_timeout(200)
    expect(alpha).to_have_text("alpha-accepted", timeout=250)

    expect(
        page.get_by_test_id(f"{grid_key}-server-values")
    ).to_have_text("alpha-accepted|bravo", timeout=10_000)
    expect(alpha).to_have_text("alpha-accepted")


@pytest.mark.parametrize(
    "grid_key",
    [
        "server_wins_callback_grid",
        "server_wins_rows_callback_grid",
    ],
)
def test_tab_to_next_cell_survives_callback_and_rapid_second_edit(
    page: Page, grid_key: str
):
    grid = page.locator(f".st-key-{grid_key}")
    alpha = _value_cell(grid, "a")
    bravo = _value_cell(grid, "b")
    expect(grid.locator(".ag-root")).to_be_visible()

    alpha.dblclick()
    alpha_editor = alpha.locator("input")
    expect(alpha_editor).to_be_visible()
    alpha_editor.fill("alpha-fast")
    alpha_editor.press("Tab")

    bravo_editor = bravo.locator("input")
    expect(bravo_editor).to_be_visible()
    page.wait_for_timeout(200)
    expect(alpha).to_have_text("alpha-fast", timeout=250)
    expect(bravo_editor).to_be_visible()
    expect(bravo_editor).to_be_focused()

    bravo_editor.fill("bravo-fast")
    bravo_editor.press("Enter")

    # Both values must reach the canonical callback-owned dataset. This also
    # guards against the second Components V2 state update replacing the first.
    expect(
        page.get_by_test_id(f"{grid_key}-callback-count")
    ).to_have_text("2", timeout=10_000)
    expect(
        page.get_by_test_id(f"{grid_key}-server-values")
    ).to_have_text("alpha-fast|bravo-fast")
    expect(alpha).to_have_text("alpha-fast")
    expect(bravo).to_have_text("bravo-fast")


@pytest.mark.parametrize(
    "grid_key",
    [
        "server_wins_reject_grid",
        "server_wins_rows_reject_grid",
    ],
)
def test_same_hash_callback_rejection_restores_authoritative_value(
    page: Page, grid_key: str
):
    grid = page.locator(f".st-key-{grid_key}")
    alpha = _value_cell(grid, "a")
    expect(grid.locator(".ag-root")).to_be_visible()
    expect(alpha).to_have_text("alpha")

    alpha.dblclick()
    editor = alpha.locator("input")
    expect(editor).to_be_visible()
    editor.fill("server-rejected")
    editor.press("Enter")

    # The callback intentionally leaves the server dataframe byte-identical.
    # Once that rerun completes, the component must still reconcile the edit.
    expect(
        page.get_by_test_id(f"{grid_key}-callback-count")
    ).to_have_text("1", timeout=10_000)
    expect(
        page.get_by_test_id(f"{grid_key}-server-values")
    ).to_have_text("alpha|bravo")
    expect(alpha).to_have_text("alpha")
    sync_token = page.get_by_test_id(f"{grid_key}-sync-token")
    first_sync_token = sync_token.inner_text()
    assert first_sync_token

    # The same entered value against the same authoritative server rows must
    # still force a component render. The private marker is proven by its new
    # token and rollback; the new submission also invokes the response callback.
    alpha.dblclick()
    repeated_editor = alpha.locator("input")
    expect(repeated_editor).to_be_visible()
    repeated_editor.fill("server-rejected")
    repeated_editor.press("Enter")
    expect(sync_token).not_to_have_text(first_sync_token, timeout=10_000)
    expect(alpha).to_have_text("alpha", timeout=10_000)
    expect(
        page.get_by_test_id(f"{grid_key}-callback-count")
    ).to_have_text("2")


def test_non_data_event_does_not_block_the_next_server_edit(page: Page):
    grid = page.locator(".st-key-server_wins_non_data_event_grid")
    alpha = _value_cell(grid, "a")
    expect(grid.locator(".ag-root")).to_be_visible()

    _row(grid, "a").locator(".ag-selection-checkbox").click()
    expect(
        page.get_by_test_id("server-wins-non-data-callback-count")
    ).to_have_text("1", timeout=10_000)

    alpha.dblclick()
    editor = alpha.locator("input")
    expect(editor).to_be_visible()
    editor.fill("after-selection")
    editor.press("Enter")

    expect(
        page.get_by_test_id("server-wins-non-data-callback-count")
    ).to_have_text("2", timeout=10_000)
    expect(
        page.get_by_test_id("server-wins-non-data-server-values")
    ).to_have_text("after-selection|bravo")
    expect(alpha).to_have_text("after-selection")


def test_server_wins_marker_and_rejection_work_inside_form(page: Page):
    grid = page.locator(".st-key-server_wins_form_grid")
    alpha = _value_cell(grid, "a")
    bravo = _value_cell(grid, "b")
    callback_count = page.get_by_test_id("server-wins-form-callback-count")
    returned_values = page.get_by_test_id("server-wins-form-returned-values")
    sync_token = page.get_by_test_id("server-wins-form-sync-token")
    submit = page.get_by_role("button", name="Submit server grid")
    expect(grid.locator(".ag-root")).to_be_visible()

    alpha.dblclick()
    editor = alpha.locator("input")
    editor.fill("server-rejected")
    editor.press("Enter")
    expect(alpha).to_have_text("server-rejected")

    bravo.dblclick()
    bravo_editor = bravo.locator("input")
    bravo_editor.fill("also-server-rejected")
    bravo_editor.press("Enter")
    expect(bravo).to_have_text("also-server-rejected")
    page.wait_for_timeout(1_000)
    expect(callback_count).to_have_text("0")

    submit.click()
    expect(callback_count).to_have_text("1", timeout=10_000)
    expect(returned_values).to_have_text(
        "server-rejected|also-server-rejected"
    )
    expect(alpha).to_have_text("alpha")
    expect(bravo).to_have_text("bravo")
    first_token = sync_token.inner_text()
    assert first_token

    alpha.dblclick()
    repeated_editor = alpha.locator("input")
    repeated_editor.fill("server-rejected")
    repeated_editor.press("Enter")
    expect(alpha).to_have_text("server-rejected")

    bravo.dblclick()
    repeated_bravo_editor = bravo.locator("input")
    repeated_bravo_editor.fill("also-server-rejected")
    repeated_bravo_editor.press("Enter")
    expect(bravo).to_have_text("also-server-rejected")
    submit.click()

    # The entered rows and authoritative result are unchanged, but this is a
    # new form submission. Its callback runs while the marker forces rollback.
    expect(sync_token).not_to_have_text(first_token, timeout=10_000)
    expect(alpha).to_have_text("alpha")
    expect(bravo).to_have_text("bravo")
    page.wait_for_timeout(1_000)
    expect(callback_count).to_have_text("2")


@pytest.mark.parametrize(
    "grid_key",
    [
        "server_wins_derived_grid",
        "server_wins_rows_derived_grid",
    ],
)
def test_server_derived_update_waits_for_tab_edit_chain(
    page: Page, grid_key: str
):
    grid = page.locator(f".st-key-{grid_key}")
    alpha = _value_cell(grid, "a")
    bravo = _value_cell(grid, "b")
    expect(grid.locator(".ag-root")).to_be_visible()

    alpha.dblclick()
    alpha_editor = alpha.locator("input")
    expect(alpha_editor).to_be_visible()
    alpha_editor.fill("alpha-derived")
    alpha_editor.press("Tab")

    bravo_editor = bravo.locator("input")
    expect(bravo_editor).to_be_visible()
    expect(bravo_editor).to_be_focused()

    # The first server response changes a derived revision while B remains in
    # edit mode. The non-active field must refresh without canceling B.
    expect(
        page.get_by_test_id(f"{grid_key}-callback-count")
    ).to_have_text("1", timeout=10_000)
    expect(
        page.get_by_test_id(f"{grid_key}-server-revisions")
    ).to_have_text("2|1")
    expect(bravo_editor).to_be_visible()
    expect(bravo_editor).to_be_focused()
    expect(_revision_cell(grid, "a")).to_have_text("2")

    bravo_editor.fill("bravo-derived")
    bravo_editor.press("Enter")

    expect(
        page.get_by_test_id(f"{grid_key}-callback-count")
    ).to_have_text("2", timeout=10_000)
    expect(
        page.get_by_test_id(f"{grid_key}-server-values")
    ).to_have_text("alpha-derived|bravo-derived")
    expect(
        page.get_by_test_id(f"{grid_key}-server-revisions")
    ).to_have_text("2|2")
    expect(_revision_cell(grid, "a")).to_have_text("2")
    expect(_revision_cell(grid, "b")).to_have_text("2")


def test_qp_v1_full_snapshot_uses_fresh_server_derived_values(page: Page):
    grid = page.locator(".st-key-qp_v1_server_wins_grid")
    row = _row(grid, "single")
    rr = row.locator(".ag-cell[col-id='RR']")
    week_1 = row.locator(".ag-cell[col-id='W1']")
    week_2 = row.locator(".ag-cell[col-id='W2']")
    expect(grid.locator(".ag-root")).to_be_visible()

    week_1.dblclick()
    week_1_editor = week_1.locator("input")
    expect(week_1_editor).to_be_visible()
    week_1_editor.fill("20")
    week_1_editor.press("Tab")

    week_2_editor = week_2.locator("input")
    expect(week_2_editor).to_be_visible()
    expect(week_2_editor).to_be_focused()
    week_2_editor.fill("30")

    # QP V1 derives RR from the first week edit. That derived value must enter
    # the live row while the next week editor remains open.
    expect(page.get_by_test_id("qp-v1-callback-count")).to_have_text(
        "1", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v1-server-values")).to_have_text(
        "15.0|20.0|10.0"
    )
    expect(rr).to_have_text("15")
    expect(week_2_editor).to_be_visible()
    expect(week_2_editor).to_be_focused()
    expect(week_2_editor).to_have_value("30")

    week_2_editor.press("Enter")

    # If the second AS_INPUT snapshot carried the stale RR=10, QP V1 would
    # interpret that as an RR edit and overwrite both weekly edits.
    expect(page.get_by_test_id("qp-v1-callback-count")).to_have_text(
        "2", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v1-server-values")).to_have_text(
        "25.0|20.0|30.0"
    )
    expect(rr).to_have_text("25")
    expect(week_1).to_have_text("20")
    expect(week_2).to_have_text("30")


def test_qp_v1_rapid_week_edits_are_serialized_behind_server_render(
    page: Page,
):
    grid = page.locator(".st-key-qp_v1_server_wins_grid")
    row = _row(grid, "single")
    rr = row.locator(".ag-cell[col-id='RR']")
    week_1 = row.locator(".ag-cell[col-id='W1']")
    week_2 = row.locator(".ag-cell[col-id='W2']")
    expect(grid.locator(".ag-root")).to_be_visible()

    week_1.dblclick()
    week_1_editor = week_1.locator("input")
    expect(week_1_editor).to_be_visible()
    week_1_editor.fill("20")
    week_1_editor.press("Tab")

    week_2_editor = week_2.locator("input")
    expect(week_2_editor).to_be_visible()
    expect(week_2_editor).to_be_focused()
    page.wait_for_timeout(200)
    week_2_editor.fill("30")
    week_2_editor.press("Enter")

    # The second full-frame collection must wait for the first callback's
    # RR=15 render; otherwise QP V1 interprets stale RR=10 as a user RR edit
    # and redistributes both weeks back to 10.
    expect(page.get_by_test_id("qp-v1-callback-count")).to_have_text(
        "1", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v1-server-values")).to_have_text(
        "15.0|20.0|10.0"
    )
    expect(week_2).to_have_text("30")
    expect(page.get_by_test_id("qp-v1-callback-count")).to_have_text(
        "2", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v1-server-values")).to_have_text(
        "25.0|20.0|30.0"
    )
    expect(rr).to_have_text("25")
    expect(week_1).to_have_text("20")
    expect(week_2).to_have_text("30")


def test_qp_v1_active_week_value_survives_rr_redistribution(page: Page):
    grid = page.locator(".st-key-qp_v1_server_wins_grid")
    row = _row(grid, "single")
    rr = row.locator(".ag-cell[col-id='RR']")
    week_1 = row.locator(".ag-cell[col-id='W1']")
    week_2 = row.locator(".ag-cell[col-id='W2']")
    expect(grid.locator(".ag-root")).to_be_visible()

    rr.dblclick()
    rr_editor = rr.locator("input")
    expect(rr_editor).to_be_visible()
    rr_editor.fill("20")
    rr_editor.press("Tab")

    week_1_editor = week_1.locator("input")
    expect(week_1_editor).to_be_visible()
    expect(week_1_editor).to_be_focused()
    week_1_editor.fill("30")

    # The RR callback redistributes both weeks to 20. W2 may refresh, but the
    # active W1 editor must keep the user's buffered 30.
    expect(page.get_by_test_id("qp-v1-callback-count")).to_have_text(
        "1", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v1-server-values")).to_have_text(
        "20.0|20.0|20.0"
    )
    expect(week_2).to_have_text("20")
    expect(week_1_editor).to_be_visible()
    expect(week_1_editor).to_be_focused()
    expect(week_1_editor).to_have_value("30")

    week_1_editor.press("Enter")
    expect(page.get_by_test_id("qp-v1-callback-count")).to_have_text(
        "2", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v1-server-values")).to_have_text(
        "25.0|30.0|20.0"
    )
    expect(rr).to_have_text("25")
    expect(week_1).to_have_text("30")
    expect(week_2).to_have_text("20")


def test_qp_v1_unchanged_active_cell_accepts_deferred_server_value(
    page: Page,
):
    grid = page.locator(".st-key-qp_v1_server_wins_grid")
    row = _row(grid, "single")
    rr = row.locator(".ag-cell[col-id='RR']")
    week_1 = row.locator(".ag-cell[col-id='W1']")

    rr.dblclick()
    rr_editor = rr.locator("input")
    expect(rr_editor).to_be_visible()
    rr_editor.fill("20")
    rr_editor.press("Tab")

    week_1_editor = week_1.locator("input")
    expect(week_1_editor).to_be_focused()
    expect(page.get_by_test_id("qp-v1-callback-count")).to_have_text(
        "1", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v1-server-values")).to_have_text(
        "20.0|20.0|20.0"
    )

    # The server's W1=20 was withheld only to protect the open editor. Leaving
    # it unchanged must install that value without emitting another return.
    week_1_editor.press("Escape")
    expect(week_1).to_have_text("20", timeout=5_000)
    page.wait_for_timeout(1_000)
    expect(page.get_by_test_id("qp-v1-callback-count")).to_have_text("1")

    # Suppression is tied to the server correction's event source. The next
    # genuine edit to the same cell must still reach Python normally.
    week_1.dblclick()
    next_editor = week_1.locator("input")
    next_editor.fill("30")
    next_editor.press("Enter")
    expect(page.get_by_test_id("qp-v1-callback-count")).to_have_text(
        "2", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v1-server-values")).to_have_text(
        "25.0|30.0|20.0"
    )


def test_qp_v1_queued_snapshot_overlays_withheld_active_server_value(
    page: Page,
):
    grid = page.locator(".st-key-qp_v1_server_wins_grid")
    row = _row(grid, "single")
    rr = row.locator(".ag-cell[col-id='RR']")
    week_1 = row.locator(".ag-cell[col-id='W1']")
    week_2 = row.locator(".ag-cell[col-id='W2']")

    rr.dblclick()
    rr_editor = rr.locator("input")
    expect(rr_editor).to_be_visible()
    rr_editor.fill("20")
    rr_editor.press("Tab")

    week_1_editor = week_1.locator("input")
    expect(week_1_editor).to_be_focused()
    page.wait_for_timeout(200)
    week_1_editor.fill("30")
    week_1_editor.press("Tab")
    week_2_editor = week_2.locator("input")
    expect(week_2_editor).to_be_focused()

    # Response 1 redistributes untouched W2 to 20 while its editor is open.
    # The queued W1 full-frame callback must serialize W2=20, not node.data's
    # temporarily withheld W2=10.
    expect(page.get_by_test_id("qp-v1-callback-count")).to_have_text(
        "1", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v1-server-values")).to_have_text(
        "20.0|20.0|20.0"
    )
    expect(week_2_editor).to_be_focused()

    expect(page.get_by_test_id("qp-v1-callback-count")).to_have_text(
        "2", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v1-server-values")).to_have_text(
        "25.0|30.0|20.0"
    )
    expect(rr).to_have_text("25")
    expect(week_1).to_have_text("30")
    expect(week_2_editor).to_be_focused()

    week_2_editor.press("Escape")
    expect(week_2).to_have_text("20", timeout=5_000)


def test_qp_v2_custom_keeps_the_next_editor_open(page: Page):
    grid = page.locator(".st-key-qp_v2_server_wins_rows_grid")
    row = _row(grid, "single")
    total = row.locator(".ag-cell[col-id='Total']")
    rr = row.locator(".ag-cell[col-id='RR']")
    week_1 = row.locator(".ag-cell[col-id='W1']")
    week_2 = row.locator(".ag-cell[col-id='W2']")
    expect(grid.locator(".ag-root")).to_be_visible()

    week_1.dblclick()
    week_1_editor = week_1.locator("input")
    expect(week_1_editor).to_be_visible()
    week_1_editor.fill("20")
    week_1_editor.press("Tab")

    week_2_editor = week_2.locator("input")
    expect(week_2_editor).to_be_focused()
    week_2_editor.fill("30")

    # V2 keeps its existing immediate exact-delta timing. Response 1 must apply
    # W1's authoritative RR without canceling or overwriting W2's editor.
    expect(page.get_by_test_id("qp-v2-callback-count")).to_have_text(
        "1", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v2-server-values")).to_have_text(
        "30.0|15.0|20.0|10.0"
    )
    expect(total).to_have_text("30")
    expect(rr).to_have_text("15")
    expect(week_2_editor).to_be_visible()
    expect(week_2_editor).to_be_focused()
    expect(week_2_editor).to_have_value("30")

    week_2_editor.press("Enter")

    expect(page.get_by_test_id("qp-v2-callback-count")).to_have_text(
        "2", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v2-server-values")).to_have_text(
        "50.0|25.0|20.0|30.0"
    )
    expect(page.get_by_test_id("qp-v2-callback-order")).to_have_text("W1|W2")
    expect(total).to_have_text("50")
    expect(rr).to_have_text("25")
    expect(week_1).to_have_text("20")
    expect(week_2).to_have_text("30")


def test_qp_v2_custom_serializes_rapid_committed_edits(
    page: Page,
):
    grid = page.locator(".st-key-qp_v2_server_wins_rows_grid")
    row = _row(grid, "single")
    total = row.locator(".ag-cell[col-id='Total']")
    rr = row.locator(".ag-cell[col-id='RR']")
    week_1 = row.locator(".ag-cell[col-id='W1']")
    week_2 = row.locator(".ag-cell[col-id='W2']")

    week_1.dblclick()
    week_1_editor = week_1.locator("input")
    week_1_editor.fill("20")
    week_1_editor.press("Tab")
    week_2_editor = week_2.locator("input")
    expect(week_2_editor).to_be_focused()
    page.wait_for_timeout(200)
    week_2_editor.fill("30")
    week_2_editor.press("Enter")

    # Model Single's CUSTOM deltas have no data revision. W2 waits behind W1's
    # authoritative render so Streamlit cannot coalesce either submission, but
    # its optimistic value must remain visible while that render is applied.
    expect(page.get_by_test_id("qp-v2-callback-count")).to_have_text(
        "1", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v2-server-values")).to_have_text(
        "30.0|15.0|20.0|10.0"
    )
    expect(week_2).to_have_text("30")

    expect(page.get_by_test_id("qp-v2-callback-count")).to_have_text(
        "2", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v2-server-values")).to_have_text(
        "50.0|25.0|20.0|30.0"
    )
    expect(page.get_by_test_id("qp-v2-callback-order")).to_have_text("W1|W2")
    expect(total).to_have_text("50")
    expect(rr).to_have_text("25")
    expect(week_1).to_have_text("20")
    expect(week_2).to_have_text("30")


def test_qp_v2_custom_preserves_three_queued_delta_generations(page: Page):
    grid = page.locator(".st-key-qp_v2_server_wins_rows_grid")
    row = _row(grid, "single")
    total = row.locator(".ag-cell[col-id='Total']")
    rr = row.locator(".ag-cell[col-id='RR']")
    week_1 = row.locator(".ag-cell[col-id='W1']")
    week_2 = row.locator(".ag-cell[col-id='W2']")
    expect(grid.locator(".ag-root")).to_be_visible()

    page.evaluate(
        """
        () => {
            const rowNode = window.__qpV2Api.getRowNode("single");
            rowNode.setDataValue("W1", 20, "edit");
        }
        """
    )
    page.wait_for_timeout(200)
    page.evaluate(
        """
        () => {
            const rowNode = window.__qpV2Api.getRowNode("single");
            rowNode.setDataValue("W2", 30, "edit");
            rowNode.setDataValue("W1", 40, "edit");
        }
        """
    )

    # The first response may update derived cells, but the two later optimistic
    # edits remain protected until their own queued responses are accepted.
    expect(page.get_by_test_id("qp-v2-callback-count")).to_have_text(
        "1", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v2-server-values")).to_have_text(
        "30.0|15.0|20.0|10.0"
    )
    expect(week_1).to_have_text("40")
    expect(week_2).to_have_text("30")

    # B's response protects C's newer W1 edit. Waiting for RR=25 proves the
    # second authoritative render has reached the grid before we inspect W1.
    expect(page.get_by_test_id("qp-v2-callback-count")).to_have_text(
        "2", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v2-server-values")).to_have_text(
        "50.0|25.0|20.0|30.0"
    )
    expect(rr).to_have_text("25")
    expect(week_1).to_have_text("40")
    expect(week_2).to_have_text("30")

    expect(page.get_by_test_id("qp-v2-callback-count")).to_have_text(
        "3", timeout=10_000
    )
    expect(page.get_by_test_id("qp-v2-callback-order")).to_have_text(
        "W1|W2|W1"
    )
    expect(page.get_by_test_id("qp-v2-server-values")).to_have_text(
        "70.0|35.0|40.0|30.0"
    )
    expect(total).to_have_text("70")
    expect(rr).to_have_text("35")
    expect(week_1).to_have_text("40")
    expect(week_2).to_have_text("30")


def test_server_wins_rows_reconciles_only_changed_rows(page: Page):
    row_grid = page.locator(".st-key-server_wins_rows_grid")
    full_grid = page.locator(".st-key-server_wins_grid")
    json_row_data_grid = page.locator(".st-key-json_row_data_grid")
    expect(row_grid.locator(".ag-root")).to_be_visible()
    expect(full_grid.locator(".ag-root")).to_be_visible()
    expect(json_row_data_grid.locator(".ag-root")).to_be_visible()
    expect(json_row_data_grid.locator(".ag-cell[col-id='value']")).to_have_text(
        "from-grid-options"
    )

    # A client edit is rolled back even though the server data hash is unchanged.
    alpha = _value_cell(row_grid, "a")
    expect(alpha).to_have_text("alpha")
    alpha.dblclick()
    editor = alpha.locator("input")
    expect(editor).to_be_visible()
    editor.fill("client-only")
    editor.press("Enter")
    expect(_value_cell(row_grid, "a")).to_have_text("alpha")

    # A client-side transaction does not emit cellValueChanged. It must still
    # mark the grid dirty so an otherwise unrelated rerun restores the same-hash
    # authoritative server snapshot.
    page.evaluate(
        """
        () => {
            window.__serverWinsRowsApi.applyTransaction({
                update: [{id: "a", value: "transaction-only", revision: 1}]
            })
        }
        """
    )
    expect(_value_cell(row_grid, "a")).to_have_text("transaction-only")
    page.get_by_role("button", name="Toggle runtime pagination").click()
    expect(_value_cell(row_grid, "a")).to_have_text("alpha")

    a_before = _object_change_count(page, "a")
    b_before = _object_change_count(page, "b")
    _row(row_grid, "a").evaluate(
        "element => element.dataset.unchangedRow = 'preserved'"
    )
    page.evaluate("window.__serverWinsRowsOptionUpdates = []")

    page.get_by_role("button", name="Apply server row changes").click()

    expect(_value_cell(row_grid, "b")).to_have_text("bravo-server")
    expect(_row(row_grid, "b").locator(".ag-cell[col-id='revision']")).to_have_text(
        "2"
    )
    expect(_row(row_grid, "c")).to_have_count(0)
    expect(_value_cell(row_grid, "d")).to_have_text("delta")
    expect(_row(row_grid, "a")).to_have_attribute("data-unchanged-row", "preserved")

    # The unchanged row keeps its exact data object, while the changed row gets
    # the new server object that tells AG Grid to refresh it.
    assert _object_change_count(page, "a") == a_before
    assert _object_change_count(page, "b") > b_before

    # A row-only Components V2 invocation must not reapply column definitions,
    # theme, or other semantically unchanged options. That work would rebuild
    # cells and erase most of the benefit of preserving unchanged row objects.
    option_updates = page.evaluate("window.__serverWinsRowsOptionUpdates")
    assert option_updates
    assert all("rowData" in keys for keys in option_updates)
    assert all(
        not {"columnDefs", "defaultColDef", "theme", "getRowId"}.intersection(keys)
        for keys in option_updates
    )

    # The ordinary server_wins path also receives JSON-serialized rerun data.
    full_values = full_grid.locator(".ag-cell[col-id='value']")
    expect(full_values).to_have_text(["alpha", "bravo-server", "delta"])

    # This update changes order only, guarding the order-sensitive data hash.
    page.get_by_role("button", name="Reorder server rows").click()
    expect(_row(row_grid, "b")).to_have_attribute("row-index", "0")
    expect(_row(row_grid, "a")).to_have_attribute("row-index", "1")
    expect(_row(row_grid, "d")).to_have_attribute("row-index", "2")


def test_component_assets_and_state_work_inside_an_outer_iframe(
    page: Page, outer_iframe_url: str
):
    # The outer document and Streamlit use different localhost ports, so this
    # exercises a genuine iframe origin boundary without triggering Chromium's
    # opaque-origin Local Network Access block for about:blank.
    page.goto(outer_iframe_url)

    embedded = page.frame_locator("#streamlit-app")
    row_grid = embedded.locator(".st-key-server_wins_rows_grid")
    expect(row_grid.locator(".ag-root")).to_be_visible()
    expect(_value_cell(row_grid, "b")).to_have_text("bravo")

    embedded.get_by_role("button", name="Apply server row changes").click()
    expect(_value_cell(row_grid, "b")).to_have_text("bravo-server")
    expect(_value_cell(row_grid, "d")).to_have_text("delta")


def test_removed_runtime_grid_option_is_reset(page: Page):
    grid = page.locator(".st-key-runtime_options_grid")
    expect(grid.locator(".ag-root")).to_be_visible()
    paging_panel = grid.locator(".ag-paging-panel")
    expect(paging_panel).to_be_visible()

    page.get_by_role("button", name="Toggle runtime pagination").click()
    expect(paging_panel).to_be_hidden()

    page.get_by_role("button", name="Toggle runtime pagination").click()
    expect(paging_panel).to_be_visible()
