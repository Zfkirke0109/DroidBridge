# Local MCP fixture regression

These Python 3.10+ tools use only the standard library. They exercise an explicitly
assigned Root MCP endpoint; they never invoke ADB, change permissions or install
anything. The operator owns the device setup and local fixture/reverse mapping.

Run the offline checks:

    python -m unittest discover -s tools -p test_mcp_test_support.py -v

Prepare an ignored output directory and a separate private credential file:

    {"root": {"port": 18766, "token": "<local-mcp-bearer>"}}

Start the local-only, bounded server in a managed terminal:

    python tools/mcp_fixture_server.py --serve --file tools/fixtures/mcp/fixture.html --max-seconds 120

The operator must create the device reverse mapping for tcp:18439, confirm it
belongs to this run, and provide the expected runtime generation and version.
Do not overwrite an existing mapping or substitute another device/host.

Execute the two cases only after setup:

    python tools/mcp_fixture_test.py --execute --credentials <private-credentials-path> --output <prepared-ignored-directory> --fixture-file tools/fixtures/mcp/fixture.html --url http://127.0.0.1:18439/ --run-id <unique-ascii-run-id> --generation <expected-root-generation> --version <expected-version>

D5 captures only loopback TCP traffic to the fixture port. An owned filesystem
download Task triggers the request; its terminal size/SHA256 and the actual
file bytes must match the fixture. Capture metadata must establish request and
response data, stay in scope and omit payload fields. The artifact reference
comes from the owned completed capture Task.
The runner appends a bounded ASCII query probe to make the request larger than
an IPv4/TCP header alone; the static server serves the same fixture for it.

D10 submits an overwrite=false download to the same existing destination.
Request admission is expected to succeed; the owned Task must settle as failed
with error.code=ALREADY_EXISTS and leave the original bytes unchanged.

File pages are requested as base64 and advanced by returned_bytes. UTF-8
characters may cross page boundaries; truncated=true never proves a full file
match. Result checks reject stale Task/capture identities and privilege changes.
A command Task's outer completed state is separate from its nested command
state; TIMEOUT is an inner failure with no exit code.

The runner uses an 80-second deadline with 20 seconds reserved for cleanup,
reads 1024-byte pages and refuses a pre-existing device
directory. It settles only owned Tasks, removes only its created directory and
verifies NOT_FOUND. A failed cleanup prevents PASS. calls.jsonl preserves
redacted calls; fixture-result.json separates cases, task outcomes and cleanup.
An output directory with an earlier result is refused instead of overwriting it.

After all cases, the operator closes the managed server, removes only the
reverse mapping created for this run, independently checks cleanup, and deletes
the temporary credential file. The server has a hard time limit and per-client
read timeout. Capture payload is omitted from read responses; temporary PCAP
artifacts and task history still follow the product's retention policy.

A pipe into nc over adb reverse may terminate before an HTTP response is read.
Diagnose such a command with matching identity/command controls before changing
the product's output collection. The capture case uses the already verified
download mechanism instead of depending on nc's stdin EOF behavior.

## Native wake regression

Build the daemon library tests for the device with cargo-ndk:

    cargo ndk -t arm64-v8a --platform 33 test --locked -p daemon --lib --no-run

Run the resulting test executable on the assigned device. Ordinary
`automation_wake::tests::` cases require no clock change. The ignored
`automation_wake::tests::rearm_after_clock_change_keeps_alarm` case requires
explicit authorization for an isolated root device: it advances CLOCK_REALTIME
by one second, restores elapsed time using CLOCK_MONOTONIC before assertions,
and checks restoration within 10 ms. Select only that case with
`--exact --ignored --nocapture`; never run all ignored tests indiscriminately.
It verifies successful rearming after a clock cancellation, no delivery after
disarm, and delivery through the production wait implementation after rearming.
