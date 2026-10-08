"""Verify Root capture, download content and asynchronous overwrite refusal over MCP."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.parse import urlsplit

from mcp_test_support import (CheckFailed, Client, TERMINAL, capture_result,
                              command_succeeded, filtered_packets, matching_content,
                              page_bytes, reply_data, require_reply, task_failed_with,
                              task_record)


def target(path):
    return {"type": "path", "value": path}


def wait_task(client, task_id, deadline, running=False):
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        task = task_record(client.call("task_control", "get", {"task_id": task_id},
                                       timeout=min(4, max(0.1, remaining))), task_id)
        if task["state"] in TERMINAL or (running and task["state"] == "running"):
            return task
        time.sleep(min(0.1, max(0, deadline - time.monotonic())))
    raise CheckFailed("Owned Task did not reach the expected state within the deadline")


def read_bytes(client, path, deadline):
    content = bytearray()
    size = None
    while time.monotonic() < deadline:
        page = require_reply(client.call("filesystem", "read",
                                        {"target": target(path), "encoding": "base64",
                                         "offset": len(content), "max_bytes": 1024},
                                        timeout=min(4, max(0.1, deadline - time.monotonic()))))
        if size is not None and page["total_size"] != size:
            raise CheckFailed("File size changed during paged reading")
        size = page["total_size"]
        if type(size) is not int or not 0 <= size <= 16384:
            raise CheckFailed("Fixture file exceeds the read bound")
        content.extend(page_bytes(page, len(content)))
        if not page["truncated"]:
            return bytes(content)
    raise CheckFailed("File paging exceeded the deadline")


def run(client, url, expected, run_id, generation, version):
    report = {"status": "FAIL", "run_id": run_id, "cases": {}, "tasks": {}, "cleanup": {}}
    directory = "/data/local/tmp/droidbridge-mcp-test-" + run_id
    page_path = directory + "/page.html"
    capture_id = None
    capture_task = None
    created = False
    task_ids = []
    deadline = time.monotonic() + 80
    client.deadline = deadline
    work_deadline = deadline - 20
    port = urlsplit(url).port
    # A bounded probe makes the request larger than any IPv4/TCP header alone.
    request_url = url + "?mcp_fixture_probe=" + run_id.ljust(128, "x")
    expected_sha = hashlib.sha256(expected).hexdigest()
    report.update(directory=directory, expected_bytes=len(expected), expected_sha256=expected_sha)
    try:
        status = require_reply(client.call("context", "status", {"detail": "full"}))
        runtime = status.get("runtime", {})
        if runtime != {"host": "magisk_backend", "host_generation": generation, "readiness": "ready"}:
            raise CheckFailed("Root runtime identity, generation or readiness changed")
        if status.get("components", {}).get("apk", {}).get("version_name") != version:
            raise CheckFailed("Device version differs from the assigned version")
        for name in ["network.capture", "network.local", "filesystem.privileged_path"]:
            if status.get("capabilities", {}).get(name, {}).get("state") != "available":
                raise CheckFailed("Required Root capability is unavailable")
        identity = require_reply(client.call("command", "run",
                                             {"command": "id -u", "run_as": "root", "as_task": False,
                                              "timeout_ms": 2000, "max_output_bytes": 1024}))
        if not command_succeeded(identity, "root") or identity.get("stdout", "").strip() != "0":
            raise CheckFailed("Root execution identity was not verified")
        absent, refused = reply_data(client.call("filesystem", "inspect", {"target": target(directory)}))
        if not refused or absent.get("code") != "NOT_FOUND":
            raise CheckFailed("Test directory is not confirmed absent")
        made = require_reply(client.call("filesystem", "manage",
                                        {"operation": "mkdir", "target": target(directory), "parents": False}))
        created = made.get("completed") is True
        if not created:
            raise CheckFailed("Test directory creation is not confirmed")
        interfaces = require_reply(client.call("network", "inspect", {"scope": "interfaces", "max_entries": 20}))
        if not any(item.get("name") == "lo" for item in interfaces.get("interfaces", [])):
            raise CheckFailed("Loopback interface is unavailable")
        start = require_reply(client.call("network", "capture",
                                          {"operation": "start", "interface": "lo",
                                           "filter": f"tcp port {port} and host 127.0.0.1",
                                           "max_duration_ms": 12000, "max_packets": 128,
                                           "max_bytes": 1048576}))
        capture_id, capture_task = start["capture_id"], start["task_id"]
        task_ids.append(capture_task)
        report.update(capture_id=capture_id, capture_task_id=capture_task)
        active = wait_task(client, capture_task, min(work_deadline, time.monotonic() + 4), running=True)
        if active["state"] != "running":
            raise CheckFailed("Capture ended before the fixture request")
        download = require_reply(client.call("filesystem", "download",
                                             {"url": request_url, "destination": target(page_path),
                                              "overwrite": False, "timeout_ms": 5000}))
        download_id = download["task_id"]
        task_ids.append(download_id)
        report["download_task_id"] = download_id
        downloaded = wait_task(client, download_id, min(work_deadline, time.monotonic() + 8))
        report["tasks"][download_id] = downloaded
        result = downloaded.get("result", {})
        if (downloaded["state"] != "completed" or downloaded.get("execution_class") != "magisk"
                or result.get("size") != len(expected) or result.get("sha256") != expected_sha):
            raise CheckFailed("Download Task did not confirm the expected bytes and identity")
        require_reply(client.call("network", "capture", {"operation": "stop", "capture_id": capture_id}))
        settled = wait_task(client, capture_task, min(work_deadline, time.monotonic() + 8))
        report["tasks"][capture_task] = settled
        capture = capture_result(settled, capture_task, capture_id)
        report["capture_ref"] = capture["capture_ref"]
        packet_page = require_reply(client.call("network", "capture",
                                                {"operation": "read", "capture_ref": capture["capture_ref"],
                                                 "include_payload": False, "max_packets": 128,
                                                 "offset_packet": 0}))
        packets = filtered_packets(packet_page, port)
        # On lo, Ethernet/IP/TCP headers cannot account for a frame over 140 bytes.
        outbound = any(p["dst_port"] == port and p["length"] > 140 for p in packets)
        inbound = any(p["src_port"] == port and p["length"] > 140 for p in packets)
        if (capture["packets_captured"] != len(packets)
                or capture["bytes_captured"] != sum(packet["length"] for packet in packets)
                or settled.get("execution_class") != "magisk"
                or not outbound or not inbound):
            raise CheckFailed("Capture does not establish both directions of fixture data")
        content = read_bytes(client, page_path, work_deadline)
        if not matching_content(content, len(expected), expected_sha):
            raise CheckFailed("Downloaded content differs from the fixture")
        report["cases"]["D5"] = {"status": "PASS", "packet_count": len(packets),
                                     "bytes_captured": capture["bytes_captured"], "packets": packets,
                                     "request_data": outbound, "response_data": inbound}
        duplicate = require_reply(client.call("filesystem", "download",
                                              {"url": request_url, "destination": target(page_path),
                                               "overwrite": False, "timeout_ms": 5000}))
        duplicate_id = duplicate["task_id"]
        task_ids.append(duplicate_id)
        rejected = wait_task(client, duplicate_id, min(work_deadline, time.monotonic() + 8))
        report["tasks"][duplicate_id] = rejected
        if not task_failed_with(rejected, duplicate_id, "ALREADY_EXISTS"):
            raise CheckFailed("Overwrite=false was not refused by the owned terminal Task")
        if read_bytes(client, page_path, work_deadline) != content:
            raise CheckFailed("Rejected download changed the original file")
        report["cases"]["D10"] = {"status": "PASS", "duplicate_task_id": duplicate_id,
                                      "duplicate_error_code": "ALREADY_EXISTS", "original_unchanged": True}
    except Exception as error:
        report["failure"] = str(error) if isinstance(error, CheckFailed) else type(error).__name__
    finally:
        cleanup_errors = []
        for task_id in task_ids:
            try:
                task = task_record(client.call("task_control", "get", {"task_id": task_id}), task_id)
                if task["state"] not in TERMINAL:
                    if task_id == capture_task:
                        require_reply(client.call("network", "capture", {"operation": "stop", "capture_id": capture_id}))
                    else:
                        require_reply(client.call("task_control", "cancel", {"task_id": task_id}))
                    task = wait_task(client, task_id, min(deadline, time.monotonic() + 6))
                report["tasks"][task_id] = task
            except Exception as error:
                cleanup_errors.append(type(error).__name__)
        report["cleanup"]["tasks_terminal"] = not cleanup_errors
        if created and not cleanup_errors:
            try:
                deleted = require_reply(client.call("filesystem", "manage",
                                                     {"operation": "delete", "target": target(directory), "recursive": True}))
                missing, refused = reply_data(client.call("filesystem", "inspect", {"target": target(directory)}))
                report["cleanup"]["directory_absent"] = (deleted.get("completed") is True
                                                            and refused and missing.get("code") == "NOT_FOUND")
                context = require_reply(client.call("context", "status", {"detail": "full"}))
                report["cleanup"]["runtime_identity_verified"] = (context.get("runtime") == runtime
                    and context.get("components", {}).get("apk", {}).get("version_name") == version)
                if not report["cleanup"]["runtime_identity_verified"]:
                    raise CheckFailed("Root runtime identity changed during the test")
            except Exception as error:
                cleanup_errors.append(type(error).__name__)
        report["cleanup"]["errors"] = cleanup_errors
        cleanup_verified = (not cleanup_errors and report["cleanup"]["tasks_terminal"]
                            and report["cleanup"].get("directory_absent") is True)
        for case in report["cases"].values():
            case["cleanup_verified"] = cleanup_verified
            if not cleanup_verified:
                case["status"] = "FAIL"
        if (not report.get("failure") and not cleanup_errors
                and report["cleanup"].get("directory_absent") is True
                and set(report["cases"]) == {"D5", "D10"}):
            report["status"] = "PASS"
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", required=True)
    parser.add_argument("--credentials", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fixture-file", type=Path, required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--generation", type=int, required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,63}", args.run_id):
        parser.error("run-id must be a unique ASCII name")
    url = urlsplit(args.url)
    if (url.scheme != "http" or url.hostname != "127.0.0.1" or url.username or url.password
            or url.path != "/" or url.query or url.fragment or not url.port or not 1025 <= url.port <= 65535):
        parser.error("url must be an explicit local-only fixture URL")
    credentials = json.loads(args.credentials.read_text(encoding="utf-8"))
    if url.port in {v["port"] for v in credentials.values()}:
        parser.error("fixture must not use an MCP port")
    if not args.output.is_dir() or (args.output / "fixture-result.json").exists():
        parser.error("output must be a prepared directory without an earlier result")
    if not 0 < args.fixture_file.stat().st_size <= 16384:
        parser.error("fixture must be at most 16 KiB")
    expected = args.fixture_file.read_bytes()
    report = run(Client("root", credentials, args.output), args.url, expected,
                 args.run_id, args.generation, args.version)
    (args.output / "fixture-result.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "cases": {k: v["status"] for k, v in report["cases"].items()},
                      "cleanup": report["cleanup"], "failure": report.get("failure")}))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
