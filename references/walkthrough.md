# Walkthrough: A Token Bucket Rate Limiter

The request: "Explain how a token bucket rate limiter works." The finished spec is `examples/token-bucket.model.json`.

## 1. Find the Surprising Part

A token bucket answers two questions a reader gets wrong: how can it allow bursts and still enforce a rate, and what happens to the request after the bucket runs dry? So the scenario needs a burst bigger than the bucket, a quiet period, then sustained traffic faster than the refill rate.

## 2. Params, State, Rules

Four sliders: bucket size, refill rate, burst size, steady traffic rate. State: `tokens`, `accepted`, `rejected`.

```json
"events": [
  { "name": "request", "at": 1, "count": "burst" },
  { "name": "request", "every": "1 / rate", "from": 8, "until": 16 }
],
"rules": {
  "tick": "tokens = min(capacity, tokens + refill * dt)",
  "on": { "request": [
    "if tokens >= 1 {",
    "  tokens -= 1; accepted += 1; emit('accept')",
    "} else {",
    "  rejected += 1; emit('reject')",
    "}"
  ] }
}
```

Each tick the bucket refills, then that tick's requests spend tokens. `emit('accept')` and `emit('reject')` drive the particles on the arrows.

## 3. Claims

```json
{ "id": "burst-passes", "kind": "at", "t": 1, "expr": "accepted == capacity", "text": "A full bucket lets exactly the first {capacity} requests of the burst through." }
{ "id": "excess-rejected", "kind": "at", "t": 1, "expr": "rejected == burst - capacity", "text": "From the {capacity + 1:ord} request on, every request in the burst is rejected." }
{ "id": "never-beyond-envelope", "kind": "always", "expr": "accepted <= capacity + refill * t", "text": "From the start to any moment t, no more than {capacity} + {refill} × t requests get through: the burst allowance plus the refill rate." }
{ "id": "slow-traffic-passes", "kind": "sweep", "samples": 40, "vary": ["rate", "refill"], "holdsWhen": "rate <= refill", "claim": { "kind": "at", "t": 16, "expr": "rejected == max(0, burst - capacity) and tokens >= min(capacity, max(0, capacity - burst) + 7 * refill) - 2" }, "text": "Steady traffic no faster than the refill rate is never turned away and leaves the bucket within two tokens of where it started; faster traffic drains it. This needs a bucket big enough to absorb uneven arrival times." }
{ "id": "refills-before-traffic", "kind": "eventually", "from": 1.1, "by": 8, "expr": "tokens == capacity", "text": "After the burst, the bucket is full again before steady traffic starts." }
{ "id": "holds-to-refill-rate", "kind": "at", "t": 16, "expr": "abs(lateRate - refill) <= 0.3", "text": "Once traffic outpaces the refill rate long enough to drain the bucket, requests pass at the refill rate, {refill} per second." }
```

The text uses `{capacity}` and `{capacity + 1:ord}`, so it reads "the 11th request" at the default and "the 13th request" when the reader sets the bucket to 12.

## 4. Check

```
$ working-model check examples/token-bucket.model.json
  PASS  burst-passes            A full bucket lets exactly the first 10 requests of the burst through.
  ...
  Sliders that break a claim:
    capacity = 1 breaks slow-traffic-passes
    capacity = 30 breaks burst-passes, excess-rejected, refills-before-traffic, holds-to-refill-rate
    refill = 0.5 breaks refills-before-traffic
    refill = 8 breaks holds-to-refill-rate
    burst = 1 breaks burst-passes, excess-rejected
    rate = 0.5 breaks holds-to-refill-rate

  6/6 claims pass
```

Two claims are deliberately not restatements of the rules. "Tokens never exceed capacity" would only read back `min(capacity, ...)`, so the invariant is the bucket's real guarantee instead: what gets through is bounded by the burst allowance plus the refill rate. And "rejected only when empty" would only read back the `else` branch, so the claim is about traffic: anything no faster than the refill rate gets through. It breaks at a bucket of one token, because requests snapped to 0.1 s ticks arrive a little unevenly and a one-token bucket has nothing to absorb that with. That is a true lesson about token buckets, not a modelling accident.

The slider report is the reader's experiment list. Drag the burst below the bucket size and "the first 10 requests pass" fails, because there were never 10 requests. Drag the refill rate down and the bucket is not full again before traffic starts. Each failure is the explanation's honest boundary.

## 5. A Weak Claim, and What to Do About It

Suppose a first draft says `"text": "The 11th request in the burst is rejected."` with `"expr": "rejected >= 1"`. `check` passes it, but lint warns:

```
W_LITERAL_NUMBER  claims.excess-rejected.text: claim "excess-rejected" has the literal number "11th"
    fix: write {capacity + 1:ord} instead of "11th" so the text follows the sliders
```

Binding the number exposes a weak claim: "at least one rejection" does not say *which* requests are rejected. The final claim says exactly how many (`rejected == burst - capacity`). That is the kind of correction to report to the user: the claim was too vague, not the model.

## 6. Build and Layout

```
$ working-model build examples/token-bucket.model.json -o token-bucket.html
built token-bucket.html (217 KB, offline, 6/6 claims pass)
$ working-model layout examples/token-bucket.model.json --out shots
token-bucket.model.json
  PASS  desktop 1280x800
  PASS  mobile 390x844
```

Hand the user `token-bucket.html`, the line "6/6 claims pass", the six claims in plain words, and the slider experiments above.
