#!/bin/bash
# Test: journaling Claude Code channel messages (notifications/claude/channel).
#
# A server declaring capabilities.experimental["claude/channel"] pushes messages with no
# id or replay. The session bridge journals each one next to polled events (same
# events-tail / events-ack), and records every window it could not be listening as a
# "disconnected" gap. 2025-11-25 only: 2026-07-28 has no unsolicited server stream.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/channel"
require_server_protocol legacy

start_test_server WITH_CHANNEL=true

SESSION=$(session_name "channel")

channel_emit() {
  curl -s -X POST "$TEST_SERVER_URL/control/channel-emit?content=$1${2:+&id=$2}" >/dev/null
}

# Wait until the journal holds the expected number of channel event records (~10s)
wait_for_channel_events() {
  local expected="$1"
  for _ in $(seq 1 50); do
    run_mcpc --json "$SESSION" events-tail --all
    if [[ $EXIT_CODE -eq 0 && "$(echo "$STDOUT" | jq '[.[] | select(.kind == "event")] | length')" == "$expected" ]]; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

# Emit until the bridge's notification stream is up and the first message lands
emit_until_received() {
  local expected="$1" content="$2"
  for _ in $(seq 1 25); do
    channel_emit "$content"
    if wait_for_channel_events_quick "$expected"; then return 0; fi
  done
  return 1
}

wait_for_channel_events_quick() {
  for _ in $(seq 1 5); do
    run_mcpc --json "$SESSION" events-tail --all
    [[ "$(echo "$STDOUT" | jq '[.[] | select(.kind == "event")] | length')" -ge "$1" ]] && return 0
    sleep 0.2
  done
  return 1
}

test_case "setup: connect to a server declaring claude/channel"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

test_case "pushed channel messages are journaled verbatim"
emit_until_received 1 "warmup" || { test_fail "first channel message should arrive"; exit 1; }
run_mcpc "$SESSION" events-ack --all
assert_success
channel_emit "hello"
channel_emit "world"
wait_for_channel_events 3 || { test_fail "both messages should be journaled"; exit 1; }
run_mcpc --json "$SESSION" events-tail
assert_success
assert_json_eq "$STDOUT" 'length' "2"
assert_json_eq "$STDOUT" '.[0].sub' "claude/channel"
assert_json_eq "$STDOUT" '.[0].data.content' "hello"
assert_json_eq "$STDOUT" '.[1].data.content' "world"
test_pass

test_case "a server-supplied message id dedupes repeats"
channel_emit "once" "m-1"
channel_emit "once" "m-1"
channel_emit "after" "m-2"
wait_for_channel_events 5 || { test_fail "m-1 once and m-2 should be journaled"; exit 1; }
run_mcpc --json "$SESSION" events-tail --all
assert_json_eq "$STDOUT" '[.[] | select(.eventId == "m-1")] | length' "1"
test_pass

test_case "events-status shows the channel listener"
run_mcpc --json "$SESSION" events-status
assert_success
assert_json_eq "$STDOUT" '.subscriptions[0].source' "channel"
assert_json_eq "$STDOUT" '.subscriptions[0].id' "claude/channel"
run_mcpc "$SESSION" events-status
assert_contains "$STDOUT" "listening"
test_pass

test_case "bridge downtime is recorded as a disconnected gap"
bridge_pid=$(jq -r ".sessions[\"$SESSION\"].pid" "$MCPC_HOME_DIR/sessions.json")
if is_windows; then
  _kill_tree "$bridge_pid"
  sleep 1
else
  kill -9 "$bridge_pid" 2>/dev/null || true
  wait_for "! kill -0 $bridge_pid 2>/dev/null" 10 || { test_fail "bridge should be dead"; exit 1; }
fi
run_mcpc "$SESSION" ping
assert_success
run_mcpc --json "$SESSION" events-tail
assert_json_eq "$STDOUT" '[.[] | select(.kind == "gap")][0].reason' "disconnected"
test_pass

test_case "messages after the restart are journaled again"
emit_until_received 6 "back" || { test_fail "messages should arrive after the restart"; exit 1; }
test_pass

test_done
