# Plan 09: Fault trees as advisory context for the virtual reactor (idea, not started)

Raised by the user on 2026-10-05: could SNEED fault trees be used by Mica / Jev in the virtual reactor (RAFT)? This is a design note, not a commitment. Nothing here starts before P3 is verified, and nothing is built in the virtual-reactor repository from this repository.

## What was read

Only enough of the virtual-reactor plans to place the question: Mica is the AI that proposes operating targets, behind the Jev server; a predictive reference governor sits above the low-level controller and below Mica's request; automatic protection never waits for AI or governor computation ([suite plan 10](../../../agents/codex/suite-virtual-reactor/docs/plans/10-predictive-governor.md), which another agent owns). Read it again before acting on this note.

## Verdict

Yes, as advisory context. No, as part of control or protection.

## What would work

- **Explanation context.** Minimal cut sets answer "which combinations of failures lose this function". They can go into Mica's context so it can explain a request or a refusal. Pass names and numbers, never raw model files.
- **Candidate ranking.** Mica could prefer proposals that keep redundancy available. The governor still re-evaluates every proposal against the latest state.
- **Tutor role.** Mica helps a student build or read a tree. Every number still comes from SCRAM and the oracle checks, never from the model.

## What stays out

- **The protection path.** Independent trips and the governor remain authoritative. Nothing from SNEED is read there.
- **Live state.** SNEED probabilities are fixed numbers with no time. A tree cannot say what is happening now (for example, that pump A has failed). Conditioning on live state is a different model and would need its own plan, assumptions and reference cases (see [plan 07](07-extensions.md)).
- **Risk claims.** Results are never frequencies or plant-risk figures. Anything Mica says from them must carry that label.
- **Automatic derivation.** No tree is derived from the simulation's equipment or a coolant diagram (already a P3 rule). A person or an explicit, reviewed mapping owns the link between a tree event and a simulated component, with a stale rule like [plan 06](06-suite-integration.md)'s component links.

## How it would be wired

Through the SEED adapter already planned in P3 (seven verbs, typed errors, oracle coverage in `describe`), not by sharing code between the repositories. The smallest first step is a read-only call, "explain this cut set", that returns names, the probability, the method, the assumptions and the label that it is not a frequency.

## Open questions

- Which component identities does virtual-reactor expose that a tree event could name?
- Does Mica get the answer as context text or as a structured tool result?
- Who reviews a mapping, and what makes it stale?
- Does the governor plan need to say that fault-tree context is advisory only, so it cannot be used later to relax a constraint?

## Before any work

Read `messages/virtual-reactor.md` and post a claim there. This repository does not edit virtual-reactor.
