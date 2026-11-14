# What Trace Evidence Does Not Establish

A Reality Bridge report is evidence about one recorded run, read through one mapping. Read it with these limits in mind.

## Model Claims Versus Observed Assertions

- A model claim is true of the simulation. It says nothing about a production system on its own.
- An observed assertion is about recorded events. It says nothing about state the trace does not record: a breaker's internal counter, a cache's contents, a queue's length. The report never evaluates an unobservable state invariant as if the trace proved it.
- The two are reported side by side and never merged. All model claims can pass while an observed assertion fails.

## Completeness

- Traces are often sampled, filtered or truncated, especially OpenTelemetry traces. A missing observed event is evidence of absence only when you declare the trace complete with `--complete`, after checking the instrumentation.
- Under `unknown` completeness, missing outputs and unpredicted outputs both make an assertion inconclusive: a dropped input can explain either.
- `--strict-observed` makes an inconclusive result fail the command. It never turns inconclusive into a recorded failure.

## Mapping

- The mapping is your claim about how observed kinds relate to model events. A wrong mapping produces a confident wrong report. Review it like code.
- Correlation needs a subject. Events without one are never matched by timing alone; they are reported as uncorrelated.
- Time is quantized to ticks. The largest shift is reported; keep it small against `withinMs`.

## Replay

- Replay drives only the model events the mapping names; every other model event must be declared internal, and keeps its own schedule.
- When a random arrival event is replayed from the trace, the model's seeded random draws differ from a normal run.
- A replay covers the trace window plus the widest match window, within the engine's tick, firing and step limits.

## What A Pass Means

A pass means: within this trace, under this mapping, every required assertion found what it tested for. It is not a proof that the system always behaves this way, not a security certification, and not formal verification. The digests in the report prove which bytes were checked, not that they are true.
