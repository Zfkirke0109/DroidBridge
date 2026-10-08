"""Strict result checks and a local HTTP transport for device MCP tests."""

import base64
import hashlib
import json
from pathlib import Path
import time
import urllib.error
import urllib.request


PROTOCOL = "2026-07-28"
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}


class CheckFailed(RuntimeError):
    pass


def reply_data(response):
    if response.get("transport_error") or response.get("error"):
        raise CheckFailed("MCP transport or JSON-RPC failure")
    envelope = response.get("result")
    if not isinstance(envelope, dict):
        raise CheckFailed("MCP result envelope is missing")
    body = envelope.get("structuredContent")
    if body is None:
        for item in envelope.get("content", []):
            if item.get("type") == "text":
                try:
                    body = json.loads(item["text"])
                    break
                except (ValueError, KeyError):
                    continue
    if not isinstance(body, dict):
        raise CheckFailed("MCP structured result is missing")
    return body, bool(envelope.get("isError"))


def require_reply(response):
    body, is_error = reply_data(response)
    if is_error:
        raise CheckFailed("MCP tool refused: " + str(body.get("code", "UNKNOWN")))
    return body


def task_record(response, expected_id):
    task = require_reply(response)
    if task.get("task_id") != expected_id:
        raise CheckFailed("Task identity does not match the admitted request")
    if task.get("state") not in TERMINAL | {"created", "queued", "running"}:
        raise CheckFailed("Task state is missing or unknown")
    return task


def task_failed_with(task, expected_id, code):
    if task.get("task_id") != expected_id:
        raise CheckFailed("Task identity does not match the admitted request")
    return task.get("state") == "failed" and task.get("error", {}).get("code") == code


def command_succeeded(result, run_as):
    return (result.get("requested_run_as") == run_as
            and result.get("actual_run_as") == run_as
            and result.get("state") == "completed"
            and result.get("exit_code") == 0)


def command_timed_out(result, run_as):
    return (result.get("requested_run_as") == run_as
            and result.get("actual_run_as") == run_as
            and result.get("state") == "failed"
            and result.get("failure_code") == "TIMEOUT"
            and result.get("exit_code") is None)


def page_bytes(page, offset):
    """Validate the response to a read explicitly requested with encoding=base64."""
    if not isinstance(page.get("truncated"), bool):
        raise CheckFailed("File page truncation evidence is missing")
    try:
        value = base64.b64decode(page["data"], validate=True)
    except (ValueError, KeyError, TypeError) as error:
        raise CheckFailed("File page is not valid base64") from error
    size = page.get("total_size")
    end = offset + len(value)
    if (type(size) is not int or type(page.get("returned_bytes")) is not int
            or page["returned_bytes"] != len(value) or not 0 <= offset <= end <= size):
        raise CheckFailed("File page byte range is inconsistent")
    if page["truncated"]:
        if not value or end >= size:
            raise CheckFailed("Truncated file page cannot advance the byte offset")
    elif end != size:
        raise CheckFailed("Final file page does not reach EOF")
    return value


def matching_content(value, expected_size, expected_sha256):
    return len(value) == expected_size and hashlib.sha256(value).hexdigest() == expected_sha256


def capture_result(task, task_id, capture_id):
    if task.get("task_id") != task_id or task.get("state") != "completed":
        raise CheckFailed("Capture Task is not the completed owned task")
    result = task.get("result", {})
    if result.get("capture_id") != capture_id or result.get("operation") != "capture_result":
        raise CheckFailed("Capture result identity does not match")
    reference = result.get("capture_ref")
    if not isinstance(reference, str) or not reference.startswith("dbref:capture:"):
        raise CheckFailed("Completed capture has no capture artifact reference")
    return result


def filtered_packets(result, port):
    packets = result.get("packets")
    if not isinstance(packets, list) or not packets or result.get("truncated") is not False:
        raise CheckFailed("Complete capture metadata is missing")
    payload_keys = {"payload_preview_base64", "payload_total_bytes", "payload_truncated"}
    for packet in packets:
        if (packet.get("protocol") != "tcp"
                or packet.get("src_ip") != "127.0.0.1"
                or packet.get("dst_ip") != "127.0.0.1"
                or port not in (packet.get("src_port"), packet.get("dst_port"))
                or payload_keys.intersection(packet)):
            raise CheckFailed("Capture escaped the fixture scope or returned payload")
    return packets


def selected_verdict(attempts, selected):
    if not selected or any(key not in attempts for key in selected):
        raise CheckFailed("Explicit attempt selection is missing")
    states = [attempts[key]["status"] for key in selected]
    if all(state == "PASS" for state in states):
        return "PASS"
    if any(state in {"FAIL", "FAILED_OR_INCONCLUSIVE", "FAILED_PRECONDITION"} for state in states):
        return "FAIL"
    if "PARTIAL" in states:
        return "PARTIAL"
    if all(state == "BLOCKED" for state in states):
        return "BLOCKED"
    if all(state == "SKIPPED" for state in states):
        return "SKIPPED"
    raise CheckFailed("Selected attempts have incompatible or unfinished verdicts")


class Client:
    """No ADB or environment mutations; credentials come from the test operator."""

    def __init__(self, edition, credentials, output):
        value = credentials[edition]
        self.edition = edition
        self.port = value["port"]
        self.token = value["token"]
        if type(self.port) is not int or not 1025 <= self.port <= 65535:
            raise CheckFailed("Invalid local MCP port")
        if not isinstance(self.token, str) or not self.token:
            raise CheckFailed("MCP credential is missing")
        self.output = Path(output)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.counter = 0
        self.deadline = None

    def rpc(self, method, params=None, label=None, timeout=8):
        if self.deadline is not None:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise CheckFailed("MCP test deadline elapsed")
            timeout = min(timeout, remaining)
        self.counter += 1
        request_id = f"{self.edition}-{time.time_ns()}-{self.counter}"
        args = dict(params or {})
        args.setdefault("_meta", {"io.modelcontextprotocol/protocolVersion": PROTOCOL,
                                  "io.modelcontextprotocol/clientCapabilities": {}})
        headers = {"Authorization": "Bearer " + self.token, "MCP-Protocol-Version": PROTOCOL,
                   "Mcp-Method": method, "Content-Type": "application/json",
                   "Accept": "application/json, text/event-stream"}
        if method == "tools/call":
            headers["Mcp-Name"] = args["name"]
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": args}
        started = time.monotonic()
        status = None
        try:
            request = urllib.request.Request(f"http://127.0.0.1:{self.port}/mcp",
                                             json.dumps(payload).encode(), headers)
            try:
                connection = self.opener.open(request, timeout=timeout)
            except urllib.error.HTTPError as error:
                connection = error
            with connection:
                status = connection.code
                raw = connection.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise CheckFailed("MCP response exceeded the test bound")
            text = raw.decode("utf-8")
            if text.startswith(("event:", "data:")):
                text = next(line[5:].strip() for line in text.splitlines() if line.startswith("data:"))
            response = json.loads(text)
            if response.get("id") != request_id:
                response["transport_error"] = "ResponseIdentityMismatch"
        except Exception as error:
            response = {"transport_error": type(error).__name__}
            if isinstance(error, urllib.error.URLError):
                response["transport_cause"] = type(error.reason).__name__
                response["transport_errno"] = getattr(error.reason, "errno", None)
        safe_response = json.loads(json.dumps(response).replace(self.token, "[REDACTED]"))
        record = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "edition": self.edition,
                  "label": label or method, "request_id": request_id, "method": method,
                  "params": args, "http_status": status,
                  "elapsed_ms": round((time.monotonic() - started) * 1000, 1),
                  "response": safe_response}
        safe_record = json.dumps(record).replace(self.token, "[REDACTED]")
        with (self.output / "calls.jsonl").open("a", encoding="utf-8") as log:
            log.write(safe_record + "\n")
        return safe_response

    def call(self, tool, action, value, label=None, timeout=8):
        return self.rpc("tools/call", {"name": tool, "arguments": {"action": action, "input": value}},
                        label=label or tool + "." + action, timeout=timeout)
