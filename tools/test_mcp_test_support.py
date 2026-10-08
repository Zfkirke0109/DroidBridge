import base64
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from mcp_test_support import (CheckFailed, Client, capture_result, command_succeeded,
                              command_timed_out, filtered_packets, page_bytes,
                              require_reply, save_visual_image, selected_verdict, task_failed_with, task_record)
from mcp_fixture_test import run


def response(body, error=False):
    return {"result": {"structuredContent": body, "isError": error}}


class ResultChecks(unittest.TestCase):
    def test_admission_is_not_the_terminal_error(self):
        admitted = require_reply(response({"task_id": "own"}))
        terminal = task_record(response({"task_id": "own", "state": "failed",
                                         "error": {"code": "ALREADY_EXISTS"}}), admitted["task_id"])
        self.assertTrue(task_failed_with(terminal, "own", "ALREADY_EXISTS"))
        self.assertFalse(task_failed_with({**terminal, "state": "running"}, "own", "ALREADY_EXISTS"))
        with self.assertRaises(CheckFailed):
            task_record(response(terminal), "another-task")

    def test_nested_timeout_is_not_command_success(self):
        command = {"state": "failed", "failure_code": "TIMEOUT",
                   "requested_run_as": "root", "actual_run_as": "root"}
        outer = task_record(response({"task_id": "own", "state": "completed", "result": command}), "own")
        self.assertTrue(command_timed_out(outer["result"], "root"))
        self.assertFalse(command_succeeded(outer["result"], "root"))
        self.assertFalse(command_timed_out({**command, "exit_code": 0}, "root"))
        self.assertFalse(command_timed_out({**command, "actual_run_as": "shell"}, "root"))
        self.assertFalse(command_timed_out({**command, "failure_code": "timeout"}, "root"))

    def test_utf8_pages_are_byte_ranges_even_across_a_character(self):
        original = ("\u7b14\u8bb0\n" * 30).encode("utf-8")
        combined = bytearray()
        for offset in range(0, len(original), 17):
            chunk = original[offset:offset + 17]
            page = {"data": base64.b64encode(chunk).decode(), "total_size": len(original),
                    "returned_bytes": len(chunk), "truncated": offset + len(chunk) < len(original)}
            combined.extend(page_bytes(page, offset))
        self.assertEqual(bytes(combined), original)
        full_page = {"data": base64.b64encode(original).decode(), "total_size": len(original),
                     "returned_bytes": len(original.decode("utf-8")), "truncated": False}
        with self.assertRaises(CheckFailed):
            page_bytes(full_page, 0)

    def test_missing_or_false_eof_evidence_is_rejected(self):
        page = {"data": base64.b64encode(b"abc").decode(), "total_size": 8,
                "returned_bytes": 3, "truncated": False}
        with self.assertRaises(CheckFailed):
            page_bytes(page, 0)
        with self.assertRaises(CheckFailed):
            page_bytes({**page, "data": "", "returned_bytes": 0, "truncated": True}, 0)
        with self.assertRaises(CheckFailed):
            page_bytes({**page, "data": "not base64!"}, 0)

    def test_capture_reference_must_come_from_the_owned_completed_task(self):
        task = {"task_id": "own", "state": "completed",
                "result": {"operation": "capture_result", "capture_id": "cap-own",
                           "capture_ref": "dbref:capture:example"}}
        self.assertEqual(capture_result(task, "own", "cap-own"), task["result"])
        for wrong in [{**task, "task_id": "other"}, {**task, "state": "running"}]:
            with self.assertRaises(CheckFailed):
                capture_result(wrong, "own", "cap-own")
        with self.assertRaises(CheckFailed):
            capture_result(task, "own", "other-capture")

    def test_capture_scope_and_payload_suppression_are_required(self):
        packet = {"protocol": "tcp", "src_ip": "127.0.0.1", "dst_ip": "127.0.0.1",
                  "src_port": 40001, "dst_port": 18439}
        self.assertEqual(filtered_packets({"packets": [packet], "truncated": False}, 18439), [packet])
        for wrong in [{**packet, "dst_ip": "192.0.2.1"}, {**packet, "dst_port": 18766},
                      {**packet, "payload_preview_base64": ""}, {**packet, "payload_total_bytes": 0},
                      {**packet, "payload_truncated": False}]:
            with self.assertRaises(CheckFailed):
                filtered_packets({"packets": [wrong], "truncated": False}, 18439)
        with self.assertRaises(CheckFailed):
            filtered_packets({"packets": [packet], "truncated": True}, 18439)

    def test_review_uses_explicit_attempts_not_a_stale_case_status(self):
        attempts = {"old": {"status": "FAILED_PRECONDITION"}, "corrected": {"status": "PASS"}}
        self.assertEqual(selected_verdict(attempts, ["corrected"]), "PASS")
        self.assertEqual(selected_verdict(attempts, ["old", "corrected"]), "FAIL")
        with self.assertRaises(CheckFailed):
            selected_verdict(attempts, ["missing"])
        with self.assertRaises(CheckFailed):
            selected_verdict({"active": {"status": "IN_PROGRESS"}}, ["active"])

    def test_tool_and_rpc_failures_cannot_be_success_data(self):
        with self.assertRaises(CheckFailed):
            require_reply(response({"code": "NOT_FOUND"}, error=True))
        with self.assertRaises(CheckFailed):
            require_reply({"error": {"code": -32603}})
        with self.assertRaises(CheckFailed):
            require_reply({"result": {}})


class TransportChecks(unittest.TestCase):
    def test_expired_deadline_cannot_send_a_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            client = Client("root", {"root": {"port": 18766, "token": "test-only-credential"}}, temporary)
            client.deadline = 0
            with patch.object(client.opener, "open") as send:
                with self.assertRaises(CheckFailed):
                    client.call("context", "status", {})
                send.assert_not_called()

    def test_wrong_response_identity_is_rejected_and_secret_is_redacted(self):
        class Connection:
            code = 200
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
            def read(self, _):
                return json.dumps({"id": "wrong", "result": {"structuredContent": {}}}).encode()

        with tempfile.TemporaryDirectory() as temporary:
            token = "test-only-credential"
            client = Client("root", {"root": {"port": 18766, "token": token}}, temporary)
            with patch.object(client.opener, "open", return_value=Connection()):
                result = client.call("command", "run", {"command": token})
            with self.assertRaises(CheckFailed):
                require_reply(result)
            log = (Path(temporary) / "calls.jsonl").read_text(encoding="utf-8")
            self.assertNotIn(token, log)
            self.assertIn("[REDACTED]", log)


def image_response(value=b"\xff\xd8private-screen-data\xff\xd9", mime="image/jpeg"):
    return {"result": {
        "structuredContent": {"image_ref": "dbref:image:owned", "image_format": mime.split("/")[1]},
        "content": [{"type": "image", "mimeType": mime,
                     "data": base64.b64encode(value).decode("ascii")}],
        "isError": False}}


class VisualChecks(unittest.TestCase):
    def test_one_observe_returns_the_image_and_log_omits_its_data(self):
        original = image_response()
        encoded = original["result"]["content"][0]["data"]

        class Connection:
            code = 200
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
            def read(self, _):
                return json.dumps(original).encode()

        with tempfile.TemporaryDirectory() as temporary:
            token = "test-only-credential"
            client = Client("root", {"root": {"port": 18766, "token": token}}, temporary)
            def send(request, **_):
                original["id"] = json.loads(request.data)["id"]
                return Connection()
            with patch.object(client.opener, "open", side_effect=send) as transport:
                result = client.call("visual", "observe",
                                     {"include_image": True, "include_nodes": False})
                destination = save_visual_image(result, Path(temporary) / "screen")
                transport.assert_called_once()
            self.assertEqual(destination.suffix, ".jpg")
            self.assertEqual(destination.read_bytes(), base64.b64decode(encoded))
            self.assertEqual(result["result"]["content"][0]["data"], encoded)
            record = json.loads((Path(temporary) / "calls.jsonl").read_text(encoding="utf-8"))
            logged = record["response"]["result"]["content"][0]
            self.assertNotIn("data", logged)
            self.assertNotIn(encoded, json.dumps(record))
            self.assertTrue(logged["data_omitted"])
            self.assertEqual(logged["base64_chars"], len(encoded))
            self.assertEqual(logged["mimeType"], "image/jpeg")
            self.assertEqual(record["response"]["result"]["structuredContent"]["image_ref"],
                             "dbref:image:owned")
            self.assertEqual(record["http_status"], 200)
            self.assertIsInstance(record["elapsed_ms"], (int, float))

    def test_format_controls_extension_and_existing_file_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            for mime, value, suffix in [
                    ("image/jpeg", b"\xff\xd8example\xff\xd9", ".jpg"),
                    ("image/png", b"\x89PNG\r\n\x1a\nexample", ".png"),
                    ("image/heic", b"\x00\x00\x00\x18ftypheic", ".heic")]:
                with self.subTest(mime=mime):
                    result = image_response(value, mime)
                    stem = Path(temporary) / mime.split("/")[1]
                    destination = save_visual_image(result, stem)
                    self.assertEqual(destination.suffix, suffix)
                    self.assertEqual(destination.read_bytes(), value)
                    with self.assertRaises(FileExistsError):
                        save_visual_image(image_response(value[:-2] + b"replacement" + value[-2:], mime), stem)
                    self.assertEqual(destination.read_bytes(), value)

    def test_missing_multiple_invalid_or_mislabelled_images_are_rejected(self):
        missing = image_response()
        missing["result"]["content"] = []
        multiple = image_response()
        multiple["result"]["content"] *= 2
        invalid = image_response()
        invalid["result"]["content"][0]["data"] = "not base64!"
        wrong_format = image_response()
        wrong_format["result"]["structuredContent"]["image_format"] = "png"
        unknown = image_response()
        unknown["result"]["content"][0]["mimeType"] = "image/gif"
        missing_ref = image_response()
        missing_ref["result"]["structuredContent"].pop("image_ref")
        refused = image_response()
        refused["result"]["isError"] = True
        with tempfile.TemporaryDirectory() as temporary:
            for result in [missing, multiple, invalid, wrong_format, unknown, missing_ref,
                           refused, image_response(b"PNG bytes", "image/png")]:
                with self.subTest(result=result):
                    with self.assertRaises(CheckFailed):
                        save_visual_image(result, Path(temporary) / "screen")
            self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_image_resource_blob_is_omitted_without_changing_the_returned_bytes(self):
        encoded = base64.b64encode(b"private-resource-image").decode()
        class Connection:
            code = 200
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
            def read(self, _):
                return json.dumps({
                    "id": request_id,
                    "result": {"contents": [
                        {"uri": "dbref:image:owned", "mimeType": "image/png", "blob": encoded},
                        {"uri": "dbref:data:owned", "mimeType": "application/octet-stream",
                         "blob": "Zm9v"}]}}).encode()

        with tempfile.TemporaryDirectory() as temporary:
            client = Client("root", {"root": {"port": 18766, "token": "test-only-credential"}}, temporary)
            def send(request, **_):
                nonlocal request_id
                request_id = json.loads(request.data)["id"]
                return Connection()
            request_id = None
            with patch.object(client.opener, "open", side_effect=send):
                result = client.rpc("resources/read", {"uri": "dbref:image:owned"})
            self.assertEqual(result["result"]["contents"][0]["blob"], encoded)
            record = json.loads((Path(temporary) / "calls.jsonl").read_text(encoding="utf-8"))
            logged = record["response"]["result"]["contents"]
            self.assertNotIn("blob", logged[0])
            self.assertEqual(logged[0]["base64_chars"], len(encoded))
            self.assertTrue(logged[0]["blob_omitted"])
            self.assertEqual(logged[1]["blob"], "Zm9v")


class FixtureClient:
    def __init__(self, content):
        self.content = content
        self.exists = False
        self.stopped = False
        self.downloads = 0
        self.cleanup_fails = False
        self.response_data = True
        self.calls = []

    def call(self, tool, action, value, **_):
        self.calls.append((tool, action, value))
        if tool == "context":
            return response({"runtime": {"host": "magisk_backend", "host_generation": 2, "readiness": "ready"},
                             "components": {"apk": {"version_name": "0.5.1"}},
                             "capabilities": {key: {"state": "available"} for key in
                                              ["network.capture", "network.local", "filesystem.privileged_path"]}})
        if tool == "command":
            return response({"state": "completed", "exit_code": 0, "actual_run_as": "root",
                             "requested_run_as": "root", "stdout": "0\n"})
        if action == "inspect":
            if tool == "network":
                return response({"interfaces": [{"name": "lo"}]})
            return response({"code": "NOT_FOUND"}, error=True)
        if action == "manage":
            if value["operation"] == "delete" and self.cleanup_fails:
                return response({"code": "IO_ERROR"}, error=True)
            self.exists = value["operation"] == "mkdir"
            return response({"completed": True})
        if action == "capture":
            if value["operation"] == "start":
                return response({"capture_id": "capture", "task_id": "capture"})
            if value["operation"] == "stop":
                self.stopped = True
                return response({"operation": "stop"})
            packets = [{"protocol": "tcp", "src_ip": "127.0.0.1", "dst_ip": "127.0.0.1",
                        "src_port": a, "dst_port": b, "length": size}
                       for a, b, size in [(40001, 18439, 180), (18439, 40001, 500 if self.response_data else 66)]]
            return response({"packets": packets, "truncated": False})
        if action == "download":
            self.downloads += 1
            return response({"task_id": f"download-{self.downloads}"})
        if action == "get":
            task_id = value["task_id"]
            if task_id == "capture":
                return response({"task_id": task_id, "state": "completed" if self.stopped else "running",
                                 "execution_class": "magisk", "result": {"operation": "capture_result",
                                  "capture_id": "capture", "capture_ref": "dbref:capture:example",
                                  "packets_captured": 2, "bytes_captured": 180 + (500 if self.response_data else 66)}})
            if task_id == "download-1":
                return response({"task_id": task_id, "state": "completed", "execution_class": "magisk",
                                 "result": {"size": len(self.content), "sha256": hashlib.sha256(self.content).hexdigest()}})
            return response({"task_id": task_id, "state": "failed", "error": {"code": "ALREADY_EXISTS"}})
        if action == "read":
            offset = value["offset"]
            chunk = self.content[offset:offset + value["max_bytes"]]
            return response({"data": base64.b64encode(chunk).decode(), "total_size": len(self.content),
                             "returned_bytes": len(chunk), "truncated": offset + len(chunk) < len(self.content)})
        raise AssertionError((tool, action))


class FixtureChecks(unittest.TestCase):
    def test_success_requires_content_refusal_capture_and_cleanup(self):
        content = ("\u7b14\u8bb0\n" * 400).encode("utf-8")
        client = FixtureClient(content)
        result = run(client, "http://127.0.0.1:18439/", content, "example", 2, "0.5.1")
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(set(result["cases"]), {"D5", "D10"})
        self.assertTrue(result["cleanup"]["directory_absent"])
        self.assertEqual(client.downloads, 2)
        downloads = [value for _, action, value in client.calls if action == "download"]
        self.assertTrue(all(value["url"] == "http://127.0.0.1:18439/?mcp_fixture_probe="
                            + "example".ljust(128, "x") for value in downloads))
        reads = [value for _, action, value in client.calls if action == "read" and "offset" in value]
        self.assertEqual(reads[1]["offset"], 1024)

    def test_cleanup_failure_cannot_leave_a_pass(self):
        client = FixtureClient(b"fixture")
        client.cleanup_fails = True
        result = run(client, "http://127.0.0.1:18439/", b"fixture", "example", 2, "0.5.1")
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(all(case["status"] == "FAIL" for case in result["cases"].values()))

    def test_control_packets_alone_do_not_establish_http_response(self):
        client = FixtureClient(b"fixture")
        client.response_data = False
        result = run(client, "http://127.0.0.1:18439/", b"fixture", "example", 2, "0.5.1")
        self.assertEqual(result["status"], "FAIL")
        self.assertIn("both directions", result["failure"])
        self.assertTrue(result["cleanup"]["directory_absent"])

    def test_changed_host_generation_stops_before_mutations(self):
        client = FixtureClient(b"fixture")
        result = run(client, "http://127.0.0.1:18439/", b"fixture", "example", 3, "0.5.1")
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(len(client.calls), 1)


if __name__ == "__main__":
    unittest.main()
