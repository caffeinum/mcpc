#!/bin/bash
# Test: mcpc supervise restarts the bridges of sessions that receive events, so a crashed
# bridge resumes journaling without anyone running a command for its session.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/supervise"
require_server_protocol modern

start_test_server WITH_EVENTS=true

SESSION=$(session_name "supervise")
IDLE=$(session_name "supidle")

server_emit_events() {
  curl -s -X POST "$TEST_SERVER_URL/control/emit-events?count=$1" >/dev/null
}

bridge_pid_of() {
  jq -r ".sessions[\"$1\"].pid" "$MCPC_HOME_DIR/sessions.json"
}

kill_bridge() {
  local pid
  pid=$(bridge_pid_of "$1")
  if is_windows; then
    _kill_tree "$pid"
    sleep 1
  else
    kill -9 "$pid" 2>/dev/null || true
    wait_for "! kill -0 $pid 2>/dev/null" 10 || return 1
  fi
}

test_case "setup: one session with a subscription, one without"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
run_mcpc connect "$TEST_SERVER_URL" "$IDLE" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$IDLE")
run_mcpc "$SESSION" events-subscribe test.durable
assert_success
test_pass

test_case "supervise --once reports a healthy bridge and ignores sessions without events"
run_mcpc --json supervise --once
assert_success
assert_json_eq "$STDOUT" "[.[] | select(.session == \"$SESSION\")][0].state" "healthy"
assert_json_eq "$STDOUT" "[.[] | select(.session == \"$IDLE\")] | length" "0"
test_pass

test_case "supervise --once restarts a crashed bridge, which resumes journaling"
kill_bridge "$SESSION" || { test_fail "bridge should die"; exit 1; }
server_emit_events 3
run_mcpc --json supervise --once
assert_success
assert_json_eq "$STDOUT" "[.[] | select(.session == \"$SESSION\")][0].state" "restarted"
# No command for the session itself: only the journal is read
for _ in $(seq 1 50); do
  run_mcpc --json "$SESSION" events-tail
  [[ "$(echo "$STDOUT" | jq length)" == "3" ]] && break
  sleep 0.2
done
assert_json_eq "$STDOUT" 'length' "3"
test_pass

test_case "supervise rejects a too-short interval"
run_mcpc supervise --interval 1
assert_failure
assert_contains "$STDERR" "at least 5 seconds"
test_pass

test_done
