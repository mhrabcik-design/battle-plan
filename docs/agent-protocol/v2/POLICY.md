# Normative command policy

Hermes risk labels are advisory. BattlePlan evaluates the exact action, receiver capability, current revision and local policy.

| Action | v2.0 schema | Default policy | Preconditions |
| --- | --- | --- | --- |
| `create_task` | yes | automatic | valid payload |
| `update_task` | yes | automatic | exact current revision, no conflict |
| `complete_task` | yes | automatic | exact current revision, no conflict |
| `archive_task` | yes | human approval | exact revision and approval digest |
| `create_worklog` | yes | automatic | active project public ID |
| `update_worklog` | yes | automatic | exact current revision, no conflict |
| `delete_worklog` | yes | human approval | exact revision and approval digest |
| `create_project` | yes | automatic | unique canonical identity |
| `update_project` | yes | automatic | exact current revision, no conflict |
| `archive_project` | yes | human approval | exact revision and approval digest |
| `merge_project` | yes | human approval | exact revisions for both heads and approval digest |
| any Settings action | **no** | forbidden | rejected as `unknown_action` before receipt |
| OAuth, pairing, key or secret action | **no** | forbidden | no schema variant |
| bulk destructive action | **no** | forbidden | no schema variant |

Automatic does not mean unconditional: wrong target, disabled capability, stale revision, expiry, conflict, trust failure, or policy mismatch fails closed. Approval is bound to the canonical preview digest and referenced revisions; a changed entity returns `stale` and requires a new command.

U1 defines validation and policy only. It intentionally contains no production mutation or approval handler.
