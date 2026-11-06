#!/bin/bash
# Test: the io.modelcontextprotocol/events extension (SEP-3415, Draft) — poll delivery
# into a durable journal, with at-least-once consumption via events-tail / events-ack.
#
# Invariants pinned down here:
#   - every emitted event reaches the journal exactly once (dedupe by eventId), including
#     across a kill -9 of the bridge and a server that replays delivered events
#   - every loss window is a gap record (truncated, terminated), never silent
#   - events-tail redelivers until events-ack, per agent, and works with the bridge down
#   - the Mcp-Name routing header mirrors the event name on events/poll

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/events"
require_server_protocol modern

start_test_server WITH_EVENTS=true

SESSION=$(session_name "events")

server_emit_events() {
  curl -s -X POST "$TEST_SERVER_URL/control/emit-events?count=$1${2:+&tag=$2}" >/dev/null
}

server_control() {
  curl -s -X POST "$TEST_SERVER_URL/control/$1" >/dev/null
}

# Wait until the agent's unacked event count reaches the expected value (~10s)
wait_for_unacked() {
  local expected="$1" agent="${2:-default}"
  for _ in $(seq 1 50); do
    run_mcpc --json "$SESSION" events-status --agent "$agent"
    if [[ $EXIT_CODE -eq 0 && "$(echo "$STDOUT" | jq -r .unacked)" == "$expected" ]]; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

# The eventIds in the journal, sorted, one per line
journal_event_ids() {
  run_mcpc --json "$SESSION" events-tail --all
  echo "$STDOUT" | jq -r '.[] | select(.kind == "event") | .eventId' | sort
}

test_case "setup: connect to a server declaring the events extension"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

test_case "events-list shows the server's event types"
run_mcpc "$SESSION" events-list
assert_success
assert_contains "$STDOUT" "test.durable"
assert_contains "$STDOUT" "[poll]"
run_mcpc --json "$SESSION" events-list
assert_success
assert_json_eq "$STDOUT" '.[0].name' "test.durable"
test_pass

test_case "events-subscribe to an unknown event type fails and registers nothing"
run_mcpc "$SESSION" events-subscribe no.such.event
assert_failure
assert_contains "$STDERR" "NotFound"
test_pass

test_case "events-subscribe starts from now: earlier events are not replayed"
server_emit_events 2
run_mcpc --json "$SESSION" events-subscribe test.durable
assert_success
assert_json_eq "$STDOUT" '.id' "test.durable"
run_mcpc --json "$SESSION" events-tail
assert_success
assert_json_eq "$STDOUT" 'length' "0"
test_pass

test_case "new events are journaled and printed by events-tail"
server_emit_events 3
wait_for_unacked 3 || { test_fail "3 events should be journaled"; exit 1; }
run_mcpc "$SESSION" events-tail
assert_success
assert_contains "$STDOUT" '{"n":3}'
assert_contains "$STDOUT" '{"n":5}'
test_pass

test_case "events/poll carries the Mcp-Name routing header"
routing=$(curl -s "$TEST_SERVER_URL/control/get-events-routing")
assert_eq "$(echo "$routing" | jq -r '[.routing[].mcpName] | unique | join(",")')" "no.such.event,test.durable"
test_pass

test_case "events-tail redelivers until acked; ack is idempotent and per agent"
run_mcpc --json "$SESSION" events-tail
first_seq=$(echo "$STDOUT" | jq -r '.[0].seq')
run_mcpc "$SESSION" events-ack "$first_seq"
assert_success
run_mcpc "$SESSION" events-ack "$first_seq"
assert_success
run_mcpc --json "$SESSION" events-tail
assert_json_eq "$STDOUT" 'length' "2"
run_mcpc --json "$SESSION" events-tail --agent reviewer
assert_json_eq "$STDOUT" 'length' "3"
MCPC_AGENT=reviewer run_mcpc --json "$SESSION" events-tail
assert_json_eq "$STDOUT" 'length' "3"
test_pass

test_case "events-ack of an unknown seq fails loudly"
run_mcpc "$SESSION" events-ack 9999
assert_failure
assert_contains "$STDERR" "Unknown event seq: 9999"
test_pass

test_case "a server replaying delivered events is deduplicated"
server_control "rewind-next-poll?by=3"
server_emit_events 1
wait_for_unacked 3 || { test_fail "only the new event should be added"; exit 1; }
assert_eq "$(journal_event_ids | uniq -d)" "" "no eventId may be journaled twice"
test_pass

test_case "truncated poll writes a gap record"
server_control "truncate-next-poll"
wait_for_unacked 4 || { test_fail "a gap record should be journaled"; exit 1; }
run_mcpc --json "$SESSION" events-tail
assert_json_eq "$STDOUT" '[.[] | select(.kind == "gap")][0].reason' "truncated"
run_mcpc "$SESSION" events-tail
assert_contains "$STDOUT" "gap (truncated)"
test_pass

test_case "kill -9 of the bridge loses nothing: events emitted meanwhile arrive once"
bridge_pid=$(jq -r ".sessions[\"$SESSION\"].pid" "$MCPC_HOME_DIR/sessions.json")
assert_not_empty "$bridge_pid"
if is_windows; then
  _kill_tree "$bridge_pid"
  sleep 1
else
  kill -9 "$bridge_pid" 2>/dev/null || true
  wait_for "! kill -0 $bridge_pid 2>/dev/null" 10 || { test_fail "bridge should be dead"; exit 1; }
fi
server_emit_events 4
# events-tail reads the journal directly, so it works with the bridge down
run_mcpc --json "$SESSION" events-tail
assert_success
assert_json_eq "$STDOUT" 'length' "4"
# Any bridge command restarts the bridge, which resumes polling from the journaled cursor
run_mcpc "$SESSION" ping
assert_success
wait_for_unacked 8 || { test_fail "the 4 events emitted while down should arrive"; exit 1; }
emitted=$(curl -s "$TEST_SERVER_URL/control/get-emitted-events" | jq -r '.events[] | select(.seq > 2) | .eventId' | sort)
assert_eq "$(journal_event_ids)" "$emitted" "journal must hold every event emitted since subscribe, once"
test_pass

test_case "events-tail --follow streams new events as NDJSON"
follow_out="$TEST_TMP/follow.ndjson"
$MCPC --json "$SESSION" events-tail --follow --all >"$follow_out" 2>/dev/null &
follow_pid=$!
sleep 1
server_emit_events 1
wait_for "grep -q '\"n\":11' '$follow_out'" 10 || { kill "$follow_pid" 2>/dev/null; test_fail "follow should print the new event"; exit 1; }
kill "$follow_pid" 2>/dev/null || true
wait "$follow_pid" 2>/dev/null || true
assert_eq "$(tail -n 1 "$follow_out" | jq -r .data.n)" "11"
test_pass

test_case "events-ack --all clears the backlog"
run_mcpc --json "$SESSION" events-ack --all
assert_success
assert_json_eq "$STDOUT" '.unacked' "0"
test_pass

test_case "a terminal server error ends the subscription with a gap record"
server_control "forbid-events"
for _ in $(seq 1 50); do
  run_mcpc --json "$SESSION" events-status
  [[ "$(echo "$STDOUT" | jq -r '.subscriptions[0].terminatedAt // empty')" != "" ]] && break
  sleep 0.2
done
assert_not_empty "$(echo "$STDOUT" | jq -r '.subscriptions[0].terminatedAt // empty')"
assert_json_eq "$STDOUT" '.unackedGaps' "1"
run_mcpc --json "$SESSION" events-tail
assert_json_eq "$STDOUT" '.[0].reason' "terminated"
assert_contains "$(echo "$STDOUT" | jq -r '.[0].detail')" "-32024"
test_pass

test_case "events-unsubscribe stops the subscription and keeps the journal"
run_mcpc --json "$SESSION" events-unsubscribe test.durable
assert_success
assert_json_eq "$STDOUT" '.unsubscribed' "true"
run_mcpc --json "$SESSION" events-status
assert_json_eq "$STDOUT" '.subscriptions | length' "0"
run_mcpc --json "$SESSION" events-tail --all
assert_json_eq "$STDOUT" '[.[] | select(.kind == "event")] | length' "9"
run_mcpc "$SESSION" events-unsubscribe test.durable
assert_failure
assert_contains "$STDERR" "No event subscription matches"
test_pass

test_done
