# Router settings

**Settings → Router** tunes the four router models without editing a rules
file or the code. The routers are FreeAuto Fast (`pliny/auto-free-fast`),
FreeAuto (`pliny/auto-free`), FreeAuto Smart (`pliny/auto-free-smart`) and
BalanceAuto (`pliny/auto-paid-balanced`). How each one routes by default is
described in [pliny-free-auto-router.md](pliny-free-auto-router.md) and
[pliny-balance-auto.md](pliny-balance-auto.md).

A change applies from the next model call, in every conversation on that
router, with no restart and no session rebuild.

## Model order

Each router has one ordered list of models, four or five at most usefully and
six at most. The first model is tried first. The others take over, in order,
when it fails, is benched, or the request does not fit its context window.

The list becomes the `use` list of the main routes: `default` (the catch-all),
`coding`, `plan-and-reasoning` and `ask-reasoning` (FreeAuto Fast has no ask
route). It is also put at the front of the pool. The `subagent`, `quick` and
`huge-context` routes keep their own lists unless you override them under
**Advanced**. To make FreeAuto start with GLM-5.2 instead of Kimi K2.6, add
GLM-5.2 and move it to the top.

Until you change it, the list shows the catch-all route's models from the
rules file. The **Customized** badge marks a router with any setting changed,
and **Reset to rules file** clears every setting of that router.

**Use only these models** limits the pool to the list plus the models of any
route override. When all of them fail, the router does not fall back to the
rest of the catalog. A request too large for every listed model still goes to
them: the size filter is relaxed before the call is refused, as it always is.
Override `huge-context` too if your list holds no 512k model.

FreeAuto profiles offer only free, self-hosted models. A paid id that reaches
one (from an older setting, or edited into global state by hand) is dropped
when the rules are built, as it is in a rules file. BalanceAuto offers the
free models and the paid hosted ones, tagged **paid**.

## Advanced

Every field shows the rules file's value as its placeholder or first option.
Clearing a field, or setting a switch back to the file's value, stores nothing,
so a later edit to the rules file applies again. A dot marks a changed field.

| Group | Settings | Rules-file field |
| --- | --- | --- |
| Routes | per route: its own model list, reasoning (quick, think, each model's default), reasoning effort, and the size bounds the route has (huge-context's "from", quick's message length and size) | `routes[].use`, `effort`, `reasoningEffort`, `when.*` |
| Classifier and judge | classifier on/off and timeout, completion judge on/off and timeout | `classifier.enabled`, `classifier.timeoutMs`, `guard.judge`, `guard.judgeTimeoutMs` |
| Failover | first-token and stall timeouts, failures before a model is benched, bench time, failovers per turn | `health.*` |
| Stalls and escalation | reminders per run, stalls before escalating, failed commands before escalating, sticky model, context margin | `escalation.*`, `sticky`, `contextMarginRatio` |
| Background models | classifier, judge, conversation summaries, commit messages | `utility.*` |

A route override is applied to every route of that name, including one a
workspace rules file adds. Choosing **Each model's default** for reasoning
removes the route's effort, so no reasoning switch is sent. A judge left on the
rules file's value follows a changed classifier model, as in a rules file.

The escalation numbers were constants before this page existed. They are now
also rules-file fields:

```yaml
escalation:
  afterStalls: 3          # stalls in a run before the firmer reminder and the switch
  afterFailedCommands: 6  # failed commands in a turn before it moves to the default route's lead
  maxNudgesPerRun: 8      # reminders per run; 0 sends none
```

BalanceAuto's `health.maxPaidCallsPerTurn` is not on this page; set it in the
rules file.

## Where it is stored and how it applies

The settings are one map per router profile, `routerTuning` in global state,
typed and normalized in `apps/vscode/src/shared/router-tuning.ts`. The router
builds a profile's rules in three layers:

1. the built-in defaults (`router-rules.ts`);
2. its rules files, global then workspace (`router-rules-store.ts`);
3. these settings (`applyRouterTuning` in `router-tuning.ts`), which replace
   only the fields they set.

`installRouter` gets a getter for the map (`sdk-session-config-builder.ts`) and
reads it on every routed call. The tuned rules are cached per rules object and
stored map, so a call rebuilds them only after one of the two changed.

Global state is cached per window. A change made in one window applies to that
window's conversations at once, and to other open windows after they reload.

The page talks to the extension through `ModelsService.getRouterSettings` and
`setRouterTuning` (`proto/cline/models.proto`). The handlers are in
`src/core/controller/models/`. Both return the whole view as JSON: for each
profile, its rules-file defaults, its tuning, and the models it may route to.
The **Open rules file** link opens the selected profile's file through
`pliny://free-auto-rules/<profile>`.
