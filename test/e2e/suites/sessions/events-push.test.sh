#!/bin/bash
# Test: push delivery (events/stream) of the events extension, with poll as the fallback.
#
#   - an event type offering push is received over a long-lived events/stream, not polled
#   - the stream carries the Mcp-Name routing header
#   - a dropped stream is reopened from the journaled cursor and a catch-up poll fills the
#     gap, so events emitted meanwhile arrive exactly once
#   - a kill -9 of the bridge loses nothing; notifications/events/terminated ends it

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/events-push"
require_server_protocol modern

start_test_server WITH_EVENTS=true

SESSION=$(session_name "evpush")

server_emit_events() {
  curl -s -X POST "$TEST_SERVER_URL/control/emit-events?count=$1" >/dev/null
}

server_control() {
  curl -s -X POST "$TEST_SERVER_URL/control/$1" >/dev/null
}

event_streams() {
  curl -s "$TEST_SERVER_URL/control/get-event-streams"
}

poll_count() {
  curl -s "$TEST_SERVER_URL/control/get-events-routing" | jq '[.routing[] | select(.method == "events/poll")] | length'
}

wait_for_journal_events() {
  for _ in $(seq 1 50); do
    run_mcpc --json "$SESSION" events-tail --all
    if [[ $EXIT_CODE -eq 0 && "$(echo "$STDOUT" | jq '[.[] | select(.kind == "event")] | length')" == "$1" ]]; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

journal_event_ids() {
  run_mcpc --json "$SESSION" events-tail --all
  echo "$STDOUT" | jq -r '.[] | select(.kind == "event") | .eventId' | sort
}

test_case "setup: connect and subscribe to a push-capable event type"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
run_mcpc --json "$SESSION" events-subscribe test.live
assert_success
assert_json_eq "$STDOUT" '.delivery | join(",")' "poll,push"
wait_for "[[ \$(event_streams | jq .open) == 1 ]]" 10 || { test_fail "one stream should be open"; exit 1; }
test_pass

test_case "events arrive over the stream, not by polling"
polls_before=$(poll_count)
server_emit_events 3
wait_for_journal_events 3 || { test_fail "3 events should arrive"; exit 1; }
assert_eq "$(poll_count)" "$polls_before" "no events/poll while the stream is up"
test_pass

test_case "events/stream carries the Mcp-Name routing header"
routing=$(curl -s "$TEST_SERVER_URL/control/get-events-routing")
assert_eq "$(echo "$routing" | jq -r '[.routing[] | select(.method == "events/stream") | .mcpName] | unique | join(",")')" "test.live"
test_pass

test_case "a dropped stream reconnects and loses nothing"
server_control "drop-event-streams"
server_emit_events 2
wait_for_journal_events 5 || { test_fail "events emitted during the drop should arrive"; exit 1; }
wait_for "[[ \$(event_streams | jq .opened) -ge 2 ]]" 10 || { test_fail "the stream should reopen"; exit 1; }
assert_eq "$(journal_event_ids | uniq -d)" "" "no eventId may be journaled twice"
test_pass

test_case "kill -9 of the bridge loses nothing"
bridge_pid=$(jq -r ".sessions[\"$SESSION\"].pid" "$MCPC_HOME_DIR/sessions.json")
if is_windows; then
  _kill_tree "$bridge_pid"
  sleep 1
else
  kill -9 "$bridge_pid" 2>/dev/null || true
  wait_for "! kill -0 $bridge_pid 2>/dev/null" 10 || { test_fail "bridge should be dead"; exit 1; }
fi
server_emit_events 2
run_mcpc "$SESSION" ping
assert_success
wait_for_journal_events 7 || { test_fail "events emitted while down should arrive"; exit 1; }
emitted=$(curl -s "$TEST_SERVER_URL/control/get-emitted-events" | jq -r '.events[].eventId' | sort)
assert_eq "$(journal_event_ids)" "$emitted" "journal must hold every event emitted since subscribe, once"
test_pass

test_case "notifications/events/terminated ends the subscription with a gap"
server_control "forbid-events"
for _ in $(seq 1 50); do
  run_mcpc --json "$SESSION" events-status
  [[ "$(echo "$STDOUT" | jq -r '.subscriptions[0].terminatedAt // empty')" != "" ]] && break
  sleep 0.2
done
assert_not_empty "$(echo "$STDOUT" | jq -r '.subscriptions[0].terminatedAt // empty')"
run_mcpc --json "$SESSION" events-tail
assert_json_eq "$STDOUT" '[.[] | select(.kind == "gap")][0].reason' "terminated"
wait_for "[[ \$(event_streams | jq .open) == 0 ]]" 10 || { test_fail "the stream should close"; exit 1; }
test_pass

test_done
