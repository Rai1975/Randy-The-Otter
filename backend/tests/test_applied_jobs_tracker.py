import csv
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import jobs_controller


class AppliedJobsTrackerTests(unittest.TestCase):
    def _patch_csv(self, tmp_path):
        target = tmp_path / "applied_jobs.csv"
        patcher = patch.object(jobs_controller, "APPLIED_JOBS_CSV", str(target))
        patcher.start()
        self.addCleanup(patcher.stop)
        return target

    def _read_rows(self, target):
        with open(target, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            return reader.fieldnames, list(reader)

    def test_writes_title_and_company(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            target = self._patch_csv(Path(tmp))
            self.assertTrue(jobs_controller._append_applied_job(
                "linkedin", "123", "Software Engineer", "Acme"))
            fieldnames, rows = self._read_rows(target)
            self.assertEqual(fieldnames, ["applied_at", "source", "job_id", "title", "company", "status"])
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["source"], "linkedin")
            self.assertEqual(rows[0]["job_id"], "123")
            self.assertEqual(rows[0]["title"], "Software Engineer")
            self.assertEqual(rows[0]["company"], "Acme")
            self.assertEqual(rows[0]["status"], "applied")
            self.assertTrue(rows[0]["applied_at"])

    def test_legacy_call_without_title_still_logs(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            target = self._patch_csv(Path(tmp))
            self.assertTrue(jobs_controller._append_applied_job("handshake", "999"))
            _, rows = self._read_rows(target)
            self.assertEqual(rows[0]["title"], "")
            self.assertEqual(rows[0]["company"], "")

    def test_dedupes_on_source_and_job_id(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            target = self._patch_csv(Path(tmp))
            self.assertTrue(jobs_controller._append_applied_job("linkedin", "1", "A", "X"))
            # Same key, different title — still deduped.
            self.assertFalse(jobs_controller._append_applied_job("linkedin", "1", "B", "Y"))
            _, rows = self._read_rows(target)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["title"], "A")

    def test_rejects_missing_identity(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            target = self._patch_csv(Path(tmp))
            self.assertFalse(jobs_controller._append_applied_job("", "1", "T", "C"))
            self.assertFalse(jobs_controller._append_applied_job("linkedin", "", "T", "C"))
            self.assertFalse(jobs_controller._append_applied_job(None, None))
            self.assertFalse(target.exists())

    def test_legacy_3col_is_upgraded_preserving_rows(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            target = self._patch_csv(Path(tmp))
            target.write_text(
                "applied_at,source,job_id\n2026-01-01T00:00:00+00:00,handshake,111\n",
                encoding="utf-8",
            )
            self.assertTrue(jobs_controller._append_applied_job(
                "linkedin", "222", "New Role", "New Co"))
            fieldnames, rows = self._read_rows(target)
            self.assertEqual(fieldnames, jobs_controller.APPLIED_JOBS_FIELDNAMES)
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["job_id"], "111")
            self.assertEqual(rows[0]["status"], "applied")
            self.assertEqual(rows[1]["job_id"], "222")
            self.assertEqual(rows[1]["title"], "New Role")

    def test_legacy_5col_is_upgraded_with_status_backfill(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            target = self._patch_csv(Path(tmp))
            target.write_text(
                "applied_at,source,job_id,title,company\n"
                "2026-01-01T00:00:00+00:00,handshake,111,Java Dev,SFORCE\n",
                encoding="utf-8",
            )
            self.assertTrue(jobs_controller._append_applied_job(
                "linkedin", "222", "New Role", "New Co"))
            fieldnames, rows = self._read_rows(target)
            self.assertEqual(fieldnames, jobs_controller.APPLIED_JOBS_FIELDNAMES)
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["title"], "Java Dev")
            self.assertEqual(rows[0]["company"], "SFORCE")
            self.assertEqual(rows[0]["status"], "applied")

    def test_text_is_single_line_and_capped(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            target = self._patch_csv(Path(tmp))
            long_title = "T" * 500
            self.assertTrue(jobs_controller._append_applied_job(
                "linkedin", "5", "  line1\nline2\rline3  ", "  co\nx  "))
            _, rows = self._read_rows(target)
            self.assertEqual(rows[0]["title"], "line1 line2 line3")
            self.assertEqual(rows[0]["company"], "co x")
            self.assertTrue(jobs_controller._append_applied_job("linkedin", "6", long_title, "C"))
            _, rows = self._read_rows(target)
            self.assertEqual(len(rows[1]["title"]), jobs_controller.APPLIED_JOB_TEXT_MAX_CHARS)

    def test_answer_yes_logs_title_and_company_with_aliases(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            target = self._patch_csv(Path(tmp))
            envelope = {
                "type": "answer",
                "answer": "yes",
                "about_job": {
                    "site": "handshake",
                    "jobId": "777",
                    "title": "Data Analyst",
                    "company": "Globex",
                },
            }
            reply, show, _ = jobs_controller._build_reply(envelope)
            self.assertEqual(reply, jobs_controller.APPLIED_YES_REPLY)
            self.assertTrue(show)
            _, rows = self._read_rows(target)
            self.assertEqual(rows[0]["source"], "handshake")
            self.assertEqual(rows[0]["job_id"], "777")
            self.assertEqual(rows[0]["title"], "Data Analyst")
            self.assertEqual(rows[0]["company"], "Globex")


class AppliedJobStatusTests(unittest.TestCase):
    def _patch_csv(self, tmp_path):
        target = tmp_path / "applied_jobs.csv"
        patcher = patch.object(jobs_controller, "APPLIED_JOBS_CSV", str(target))
        patcher.start()
        self.addCleanup(patcher.stop)
        return target

    def test_create_defaults_to_applied(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            target = self._patch_csv(Path(tmp))
            jobs_controller._append_applied_job("linkedin", "1", "T", "C")
            with open(target, newline="", encoding="utf-8") as f:
                rows = list(__import__("csv").DictReader(f))
            self.assertEqual(rows[0]["status"], "applied")

    def test_create_normalizes_case_and_rejects_invalid(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            self._patch_csv(Path(tmp))
            self.assertEqual(
                jobs_controller._normalize_applied_job_status("Interview"), "interview")
            self.assertEqual(
                jobs_controller._normalize_applied_job_status("  ACCEPTED "), "accepted")
            self.assertIsNone(jobs_controller._normalize_applied_job_status("ghosted"))
            self.assertIsNone(jobs_controller._normalize_applied_job_status(""))
            self.assertIsNone(jobs_controller._normalize_applied_job_status(None))

    def test_create_with_invalid_status_falls_back_to_applied(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            target = self._patch_csv(Path(tmp))
            self.assertTrue(jobs_controller._append_applied_job(
                "linkedin", "9", "T", "C", status="ghosted"))
            with open(target, newline="", encoding="utf-8") as f:
                rows = list(__import__("csv").DictReader(f))
            self.assertEqual(rows[0]["status"], "applied")


class AppliedJobsEndpointsTests(unittest.TestCase):
    def _client(self, tmp_path):
        from flask import Flask
        target = tmp_path / "applied_jobs.csv"
        patcher = patch.object(jobs_controller, "APPLIED_JOBS_CSV", str(target))
        patcher.start()
        self.addCleanup(patcher.stop)
        app = Flask(__name__)
        app.register_blueprint(jobs_controller.jobs_bp)
        return app.test_client()

    def _seed(self, client_target=None):
        jobs_controller._append_applied_job("linkedin", "1", "Eng", "Acme")
        jobs_controller._append_applied_job("handshake", "2", "Data", "Globex")

    def test_get_empty(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            client = self._client(Path(tmp))
            resp = client.get("/applied-jobs")
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json["jobs"], [])
            self.assertEqual(resp.json["count"], 0)

    def test_get_lists_and_filters(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            client = self._client(Path(tmp))
            self._seed()
            resp = client.get("/applied-jobs")
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json["count"], 2)
            self.assertEqual(resp.json["jobs"][0]["status"], "applied")

            resp = client.get("/applied-jobs?status=applied")
            self.assertEqual(resp.json["count"], 2)
            resp = client.get("/applied-jobs?status=interview")
            self.assertEqual(resp.json["count"], 0)
            # Case-insensitive filter.
            resp = client.get("/applied-jobs?status=Applied")
            self.assertEqual(resp.json["count"], 2)
            resp = client.get("/applied-jobs?status=bogus")
            self.assertEqual(resp.status_code, 400)

    def test_patch_updates_status_only(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            client = self._client(Path(tmp))
            self._seed()
            resp = client.patch("/applied-jobs", json={
                "source": "linkedin", "job_id": "1", "status": "Interview"})
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json["job"]["status"], "interview")
            self.assertEqual(resp.json["job"]["title"], "Eng")
            # Alias keys work too.
            resp = client.patch("/applied-jobs", json={
                "site": "handshake", "jobId": "2", "status": "rejected"})
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json["job"]["status"], "rejected")

    def test_patch_rejects_bad_input(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            client = self._client(Path(tmp))
            self._seed()
            self.assertEqual(
                client.patch("/applied-jobs", json={
                    "source": "linkedin", "job_id": "1", "status": "ghosted"}).status_code, 400)
            self.assertEqual(
                client.patch("/applied-jobs", json={
                    "source": "linkedin", "job_id": "1"}).status_code, 400)
            self.assertEqual(
                client.patch("/applied-jobs", json={
                    "source": "linkedin", "status": "applied"}).status_code, 400)
            self.assertEqual(
                client.patch("/applied-jobs", json={
                    "source": "linkedin", "job_id": "404", "status": "applied"}).status_code, 404)
            self.assertEqual(
                client.patch("/applied-jobs", data="nope",
                             content_type="text/plain").status_code, 400)

    def test_delete_removes_row(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            client = self._client(Path(tmp))
            self._seed()
            resp = client.delete("/applied-jobs", json={"source": "linkedin", "job_id": "1"})
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json["deleted"], {"source": "linkedin", "job_id": "1"})
            resp = client.get("/applied-jobs")
            self.assertEqual(resp.json["count"], 1)
            self.assertEqual(resp.json["jobs"][0]["job_id"], "2")

    def test_delete_unknown_and_missing(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            client = self._client(Path(tmp))
            self._seed()
            self.assertEqual(
                client.delete("/applied-jobs",
                              json={"source": "x", "job_id": "y"}).status_code, 404)
            self.assertEqual(
                client.delete("/applied-jobs", json={"source": "linkedin"}).status_code, 400)
            # Query-param fallback.
            resp = client.delete("/applied-jobs?source=handshake&job_id=2")
            self.assertEqual(resp.status_code, 200)


class ProfileEndpointTests(unittest.TestCase):
    def test_get_profile_returns_autofill_fields_from_environment(self):
        from flask import Flask
        app = Flask(__name__)
        app.register_blueprint(jobs_controller.jobs_bp)
        with patch.dict("os.environ", {
            "FIRST_NAME": "Randy",
            "LAST_NAME": "Otter",
            "EMAIL": "randy@example.com",
            "PHONE_NUMBER": "+1 555 0100",
            "ADDRESS": "1 Riverbank Way",
        }, clear=False):
            response = app.test_client().get("/profile")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {
            "first_name": "Randy",
            "last_name": "Otter",
            "email": "randy@example.com",
            "phone_number": "+1 555 0100",
            "address": "1 Riverbank Way",
            "linkedin_url": "",
            "website_url": "",
            "veteran_status": "",
            "disability_status": "",
            "race": "",
            "gender": "",
        })

    def test_greenhouse_autofill_reply_is_deterministic_and_not_a_question(self):
        reply, show, payload = jobs_controller._build_reply({"type": "greenhouse-autofill"})
        self.assertIn("double check", reply)
        self.assertTrue(show)
        self.assertIsNone(payload)
        self.assertFalse(jobs_controller._is_question({"type": "greenhouse-autofill"}))


if __name__ == "__main__":
    unittest.main()
