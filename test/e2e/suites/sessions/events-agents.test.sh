#!/bin/bash
# Test: several agents sharing one session's events (journal once, route per agent).
#
#   - agents subscribing to the same event type share one subscription (one poll loop)
#   - addressed records (--route) reach only the agents they name; unaddressed ones reach
#     every subscribed agent; an agent cannot acknowledge another agent's records
#   - records naming no subscribed agent are "unrouted", visible, never dropped
#   - one agent unsubscribing keeps the subscription for the others

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/events-agents"
require_server_protocol modern

start_test_server WITH_EVENTS=true

SESSION=$(session_name "evagents")

server_emit_events() {
  curl -s -X POST "$TEST_SERVER_URL/control/emit-events?count=$1${2:+&tag=$2}" >/dev/null
}

# Wait until the whole journal holds the expected number of event records (~10s)
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

# The data.n values an agent sees in its backlog, comma-separated
backlog_of() {
  run_mcpc --json "$SESSION" events-tail --agent "$1"
  echo "$STDOUT" | jq -r '[.[] | select(.kind == "event") | .data.n] | join(",")'
}

test_case "setup: connect"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

test_case "two agents subscribing to one event type share one subscription"
MCPC_AGENT=alice run_mcpc --json "$SESSION" events-subscribe test.durable --route data.tag
assert_success
assert_json_eq "$STDOUT" '.route.agents | join(",")' "alice"
run_mcpc --json "$SESSION" events-subscribe test.durable --agent bob
assert_success
assert_json_eq "$STDOUT" '.route.agents | join(",")' "alice,bob"
assert_json_eq "$STDOUT" '.route.path' "data.tag"
run_mcpc --json "$SESSION" events-status
assert_json_eq "$STDOUT" '.subscriptions | length' "1"
test_pass

test_case "addressed records reach only their recipient; unaddressed reach both"
server_emit_events 1 alice
server_emit_events 1 bob
server_emit_events 1
wait_for_journal_events 3 || { test_fail "3 events should be journaled"; exit 1; }
assert_eq "$(backlog_of alice)" "1,3"
assert_eq "$(backlog_of bob)" "2,3"
assert_eq "$(backlog_of carol)" "" "an agent that never subscribed receives nothing"
test_pass

test_case "an agent cannot acknowledge another agent's record"
run_mcpc --json "$SESSION" events-tail --agent bob
bob_seq=$(echo "$STDOUT" | jq -r '.[0].seq')
run_mcpc "$SESSION" events-ack "$bob_seq" --agent alice
assert_failure
assert_contains "$STDERR" "not routed to agent \"alice\""
run_mcpc "$SESSION" events-ack "$bob_seq" --agent bob
assert_success
assert_eq "$(backlog_of bob)" "3"
assert_eq "$(backlog_of alice)" "1,3" "bob's ack must not touch alice's backlog"
test_pass

test_case "a record naming no subscribed agent is unrouted, not dropped"
server_emit_events 1 mallory
wait_for_journal_events 4 || { test_fail "the event should be journaled"; exit 1; }
run_mcpc --json "$SESSION" events-tail --unrouted
assert_json_eq "$STDOUT" '.[0].data.tag' "mallory"
run_mcpc --json "$SESSION" events-status --agent alice
assert_json_eq "$STDOUT" '.unrouted' "1"
assert_eq "$(backlog_of alice)" "1,3"
test_pass

test_case "events-route shows and edits the route"
run_mcpc --json "$SESSION" events-route test.durable --add carol
assert_success
assert_json_eq "$STDOUT" '.agents | join(",")' "alice,bob,carol"
assert_eq "$(backlog_of carol)" "3" "carol now gets the unaddressed backlog"
run_mcpc --json "$SESSION" events-route test.durable --remove carol
assert_json_eq "$STDOUT" '.agents | join(",")' "alice,bob"
run_mcpc "$SESSION" events-route test.durable --path "bad..path"
assert_failure
assert_contains "$STDERR" "Invalid route path"
test_pass

test_case "one agent unsubscribing keeps the subscription for the others"
run_mcpc --json "$SESSION" events-unsubscribe test.durable --agent bob
assert_success
assert_json_eq "$STDOUT" '.remainingAgents | join(",")' "alice"
run_mcpc --json "$SESSION" events-status
assert_json_eq "$STDOUT" '.subscriptions | length' "1"
MCPC_AGENT=alice run_mcpc --json "$SESSION" events-unsubscribe test.durable
assert_success
assert_json_eq "$STDOUT" '.name' "test.durable"
run_mcpc --json "$SESSION" events-status
assert_json_eq "$STDOUT" '.subscriptions | length' "0"
test_pass

test_done
