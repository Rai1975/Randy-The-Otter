import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from agents import randy_main
import jobs_controller
from tools.file_channel import bind_file_session, pop_pending_file, reset_file_session, set_pending_file


class CoverLetterSessionHandoffTests(unittest.TestCase):
    def test_forwards_session_id_to_stateless_specialist(self):
        calls = []

        def specialist(*args, **kwargs):
            calls.append((args, kwargs))
            return "Success!"

        with patch.object(randy_main, "_cover_letter_agent", specialist):
            response = randy_main.generate_cover_letter_for_job("session-123", "job description")

        self.assertEqual(response, "Success!")
        self.assertEqual(calls, [(("job description",), {"invocation_state": {"session_id": "session-123"}})])

    def test_controller_invokes_cover_letter_specialist_without_the_orchestrator(self):
        with patch.object(jobs_controller, "generate_cover_letter_for_job", return_value="Success!") as specialist:
            with patch.object(jobs_controller, "get_randy_agent") as orchestrator:
                response, payload = jobs_controller._agent_reply(
                    "session-123", "job description", action="cover-letter"
                )

        self.assertEqual((response, payload), ("Success!", None))
        specialist.assert_called_once_with("session-123", "job description")
        orchestrator.assert_not_called()

    def test_uses_default_for_an_invalid_session_id(self):
        calls = []

        def specialist(*args, **kwargs):
            calls.append((args, kwargs))
            return "Success!"

        with patch.object(randy_main, "_cover_letter_agent", specialist):
            randy_main.generate_cover_letter_for_job("not/a/session", "job description")

        self.assertEqual(calls[0][1]["invocation_state"], {"session_id": "default"})

    def test_bound_request_session_is_used_when_a_nested_tool_has_no_context(self):
        token = bind_file_session("session-456")
        try:
            set_pending_file("cover-letter.pdf")
        finally:
            reset_file_session(token)

        pending = pop_pending_file("session-456")
        self.assertIsNotNone(pending)
        self.assertEqual(pending["filename"], "cover-letter.pdf")

    def test_job_summary_encodes_a_file_set_by_a_nested_tool(self):
        app = Flask(__name__)
        app.register_blueprint(jobs_controller.jobs_bp)

        with tempfile.TemporaryDirectory() as temp_dir:
            pdf_path = Path(temp_dir) / "letter.pdf"
            pdf_path.write_bytes(b"%PDF-test")

            def build_reply(_envelope):
                # This mirrors a specialist that lost direct invocation_state.
                # The request-bound context must still route its file correctly.
                set_pending_file(str(pdf_path), filename="letter.pdf")
                return "generated", True, None

            with patch.object(jobs_controller, "_build_reply", build_reply):
                response = app.test_client().post(
                    "/job-summary",
                    json={"session_id": "session-789", "type": "job", "action": "cover-letter"},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["payload"]["file"]["filename"], "letter.pdf")
        self.assertEqual(response.json["payload"]["file"]["data_base64"], "JVBERi10ZXN0")


if __name__ == "__main__":
    unittest.main()
