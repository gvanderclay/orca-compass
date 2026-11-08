# How it works

OrcaCompass recommends a route; the orchestrator starts and verifies the worker.
The [Skill workflow](skill-workflow.md) describes that sequence.

1. **Build a placement table.** Agent discovery and available metadata determine
   which tiers each model can serve. The table is cached for five hours by
   default and rebuilt when stale or on `orcacompass refresh`.
2. **Gather current state.** Each route reads the table, Orca usage and agent
   settings, configuration, and active model rejections.
3. **Choose a route.** The router filters candidates by availability, tier,
   preferences, bans, usage and other constraints, then ranks eligible routes.
   It returns an agent, model, effort, explanations, and launch arguments, or
   explains why no route is available.
4. **Launch and verify.** The orchestrator passes the returned arguments to
   Orca and checks whether the agent accepted the model. A refusal can be saved
   so subsequent routes avoid it.

Run `orcacompass status` for current state and `orcacompass tiers` to inspect
model placements. See [Tiers and routing](tiers-and-routing.md) for the rules,
[Configuration](configuration.md) for cache and privacy details, and
[Verify and rejections](verify-and-rejections.md) for recovery.
