# Actor memory evidence-funnel benchmark

Status: deterministic offline regression harness. This measures **source-to-retrieval-to-prompt evidence availability**, not an NPC's answer quality or live local-model accuracy.

## Run

```sh
npm test
npm run eval:memory
npm run eval:memory -- --json
```

The script uses the same SQLite `StudioStore`, `actor_memories` / `actor_facts` retrievers, and `buildActorContext` used by acting NPCs. No model, HTTP request, embedding library, network, judge, or new dependency is involved. The fixture is rebuilt in an in-memory database for each run and is not shipped into a player's worlds.

## What the fixture covers

- **52 intervening witnessed turns** between historical evidence and current conversation.
- **Four lexical cues:** an older dialogue detail, a pinned dialogue detail, a reviewed promise, and a corrected reviewed belief.
- **One composed cue:** a greenhouse entrance code **and** a separate promise; both sources are required to score full support.
- **One implicit cue:** concern about jewelry and rain should potentially activate an old pendant-under-bench memory even without repeating its words. This is **diagnostic only**, because today's FTS5 retriever lacks semantic paraphrase search.
- **Six negative checks:** another actor's private exchange; source-edited reviewed memory; superseded fact; revoked fact; parent-only event leaking into a child fork; and previously valid memory surviving in that fork.
- Prompt packing at **2,048 and 4,096 tokens**, using the app's offline token estimator, a 350-token response reserve, and the normal safety margin. This checks estimated prompt fit; native exact-tokenizer behavior remains covered separately by backend tests.

Gold evidence is identified by **source message IDs or reviewed fact IDs**, never substring presence in a prompt (which could accidentally be repeated by the current user). Each positive case measures whether the source is stored, whether it is retrieved in the top five **within its own memory type**, and whether its provenance ID survives context assembly. No cross-type global top-five ranking is claimed.

The metrics are:
- **Evidence recall:** fraction of annotated supporting sources present at each stage.
- **All-support rate:** fraction of questions for which *every* required source survived.
- **MRR:** reciprocal rank of the earliest retrieved gold source within its type (retrieval stage only).
- **Safety failures:** any unauthorized, invalidated, revoked or future-parent evidence found.
- **Budget failures:** estimated input exceeds context minus response reserve and safety margin.

## Baseline diagnosis and fix

Initial observed baseline (2026-11-14, Node 22/24 CI; 6 synthetic positive questions):

| Subset | Stored | Retrieved @5 | Packed 2048 before fix | Packed 2048 after fix | Packed 4096 after fix |
|---|---:|---:|---:|---:|---:|
| Lexical (4 questions) | 100% | 100% | 0% | 100% | 100% |
| Composed (1 question, 2 gold sources) | 100% | 100% | 0% | 100% | 100% |
| Implicit (1 question) | 100% | 0% | 0% | 0% | 0% |

All six negative checks passed after the fix.

**Cause:** the context assembler packed up to 24 recent dialogue turns first, exhausting the 2,048-token input budget before retrieved memories could be admitted.

**Change:** when evidence candidates exist, reserve up to 28% of the available prompt input budget, capped at 440 estimated tokens, while selecting *older* recent turns. The latest actual conversation turn is never displaced. Evidence selection then uses the remaining budget; the reserved space is not a mandatory filler allocation. The continuation-mode assembler also refuses to drop the only remaining real conversation turn.

This is a deliberately small allocation-policy fix, not a replacement for lexical retrieval. Different character profiles, longer turns and real native tokenizer counts may produce different outcomes.

## CI gates

The offline command exits nonzero, and the Node tests assert, when:
- Not all gold sources were stored.
- Lexical source recall @5 is below 75%.
- Lexical provenance recall in a 2,048-token assembled prompt is below 75%.
- The composed prompt fails to contain both sources at 4,096 tokens.
- Any estimated token budget is exceeded.
- Any of the six negative safety/fork checks fails.

The implicit case is reported, **not used to force a failure**. These thresholds are minimum regression gates for a tiny synthetic fixture, not industry benchmarks or achieved real-world correctness.

## Next justified experiment: semantic retrieval

The implicit failure is now measurable. Compare lexical-only FTS5 with an optional **local, CPU-friendly semantic candidate index** using the *same* fixture first, then expand to diverse annotated implicit and composed queries. Embedding vectors are a replaceable, versioned, derived cache—not canonical memory and never a reason to widen actor, world or timeline visibility. Apply actor/timeline authorization and source validity **before** candidate ranking/injection; fork snapshots must remain isolated. Measure all-support rate and final packed evidence, not merely the vector index's search hits. Keep lexical as a fallback when no local embedding provider is available.

Research guiding the stage separation:
- [EviCover: Where Did the Evidence Go? (2026)](https://arxiv.org/abs/2611.10170): annotated support sets through retrieval and final context.
- [EvalMem: Operation-Level Diagnostic Framework (2026)](https://arxiv.org/abs/2609.22231): distinguish storage, retrieval and use.
- [LOCOMO-CONV: When Users Don't Ask (2026)](https://arxiv.org/abs/2609.03467): distinguish direct QA from implicit conversational recall.

Avoid comparing these synthetic values to published LoCoMo / LongMemEval accuracy numbers: the datasets, context limits, retrieval units and metrics differ.
