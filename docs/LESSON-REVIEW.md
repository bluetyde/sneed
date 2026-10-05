# Lesson review sheet

Generated from `lessons/*.json` by `node scripts/lesson-review.mjs`. Regenerate after any change to a lesson, because a sign-off applies to the text below and nothing else.

The reviewer is the course instructor or another subject-matter reader, not the author of the lessons. A mechanical readability score and the author's own read are not a review.

## What to check in each lesson

1. Is every statement true, including the hand calculations?
2. Does anything state or imply a real plant, a frequency or a safety conclusion?
3. Is the wording right for the students (reading level, jargon introduced after plain language)?
4. Does each step say what a student must do, in the words the editor uses?
5. Does each "check this" message teach the right thing without giving the answer away?
6. Is anything missing that a first-time student would need?

## A single pump

File: `lessons/01-single-pump.json`

**Goals**
- Name a basic event and give it a probability between 0 and 1.
- Make that event the top event and read the result.

**Assumptions shown to the student:** The probability 0.1 is made up for teaching. It describes no real pump and says nothing about any plant.

**Steps**
1. Add one basic event and name it P, for "Pump P fails".
   - Hint: Use the Basic event button. Then select the event, open the Properties tab and type P in the Name field. The lesson finds your events by their names.
2. Give P a probability of 0.1. Write it as a fraction of 1, so 10 percent is 0.1.
   - Hint: Probabilities run from 0 to 1. 0.1 means one chance in ten.
3. Make P the top event "No coolant flow", then run the analysis.
   - Hint: With one pump and no other way to lose flow, the pump failing is the top event.

**Expected results** (each equals an independently checked oracle entry)
- One pump, p = 0.1: probability 0.1; cut sets {P} (oracle `pra-pump1`)

**"Check this" messages**
- A probability of 10 is not allowed. Probabilities are between 0 and 1, so 10 percent is written 0.1.
- A gate with one input only repeats that input. Use the event itself as the top event.
- An event that no gate uses and that is not the top event does not affect the result.

**Hand calculation (shown after the student has run the model)**
- There is one way to lose flow: the pump fails.
- Top event probability = P(P) = 0.1. The only cut set is {P}.

**Reviewer**

- Name and role: 
- Date: 
- Verdict (approved / approved with changes / not approved): 
- Changes asked for: 

## Redundant pumps

File: `lessons/02-redundant-pumps.json`

**Goals**
- Use AND and OR gates and see what redundancy buys.
- See that the same events give different answers under different logic.

**Assumptions shown to the student:** Pumps P1 and P2 fail independently, each with a made-up probability of 0.1. Nothing here describes a real plant.

**Steps**
1. Add two basic events named P1 and P2, each with probability 0.1.
   - Hint: The AND gate button adds two events for you. Name each one in the Name field of the Properties tab. The lesson finds your events by their names.
2. Make a gate for "No coolant flow" that is true only when P1 AND P2 both fail. It must be the top event. Then run.
   - Hint: An AND gate fails only when every input fails. The first gate you add becomes the top event.
3. Now suppose either pump failing stops the flow. Change the gate to OR and run again.
   - Hint: Select the gate and change its type in the properties panel. An OR gate fails when any input fails.

**Expected results** (each equals an independently checked oracle entry)
- Either pump is enough (AND): probability 0.01; cut sets {P1, P2} (oracle `pra-pump2-and`)
- Either pump failing stops flow (OR): probability 0.19; cut sets {P1}, {P2} (oracle `pra-pump2-or`)

**"Check this" messages**
- A probability above 1 is not allowed. Write 10 percent as 0.1.
- A gate with one input only repeats that input. Give the gate both pumps.
- One of your events is not connected to any gate, so it does not change the result.

**Hand calculation (shown after the student has run the model)**
- AND: both fail, so multiply. 0.1 x 0.1 = 0.01. One cut set of order 2: {P1, P2}.
- OR: at least one fails, so 1 - (1 - 0.1)^2 = 1 - 0.81 = 0.19. Two cut sets of order 1: {P1}, {P2}.
- Same two events, different logic, different answer.

**Reviewer**

- Name and role: 
- Date: 
- Verdict (approved / approved with changes / not approved): 
- Changes asked for: 

## Redundant pumps with a shared power supply

File: `lessons/03-shared-power-supply.json`

**Goals**
- See how one event used in two places differs from two separate events.
- See why a shared cause can dominate a redundant design.

**Assumptions shown to the student:** P1 and P2 each fail with a made-up probability of 0.1. The power supply S fails with a made-up probability of 0.05 and feeds both pumps. Nothing here describes a real plant.

**Steps**
1. Add three basic events named P1 (0.1), P2 (0.1) and S for "Power supply fails" (0.05).
   - Hint: S is one event. Both pumps lose power when it fails. Name each event in the Name field; the lesson finds your events by their names.
2. Build each pump's failure as (pump fails OR S fails), then make the top event "No coolant flow" the AND of the two.
   - Hint: Two OR gates, one per pump, under an AND gate.
3. Connect the same event S under both OR gates. Run, then compare with the pair alone.
   - Hint: Select the second OR gate, choose S in the list "Add an existing node as an input", and press Add input. Do not add another event.

**Expected results** (each equals an independently checked oracle entry)
- One supply S under both pumps: probability 0.0595; cut sets {P1, P2}, {S} (oracle `pra-pump3-shared`)
- Two separate supplies S1 and S2 (two copies): probability 0.021025; cut sets {P1, P2}, {P1, S2}, {P2, S1}, {S1, S2} (oracle `pra-pump3-separate`)

**"Check this" messages**
- You have more than three events. One shared power supply is one event, S, used by both pumps. Separate events S1 and S2 describe two supplies, and they give a different answer.
- A probability above 1 is not allowed. Write 5 percent as 0.05.
- A gate with one input only repeats that input.

**Hand calculation (shown after the student has run the model)**
- Shared: the top event happens if S fails, or both pumps fail. P(S) + P(P1 P2) - P(S) P(P1 P2) = 0.05 + 0.01 - 0.0005 = 0.0595. Cut sets {S} and {P1, P2}.
- The pair alone gives 0.01, so the shared supply makes the result about six times larger.
- Two separate supplies: (1 - 0.95 x 0.9)^2 = 0.145^2 = 0.021025, about three times smaller than the shared case.
- The tree drawn is the same shape in both cases. Only the identity of the supply changes, and that changes the answer. Which version matches a single shared supply?

**Reviewer**

- Name and role: 
- Date: 
- Verdict (approved / approved with changes / not approved): 
- Changes asked for: 

## Voting (2 out of 3)

File: `lessons/04-voting.json`

**Goals**
- Use a K-of-N voting gate.
- See how the three calculation methods differ and when the approximations are safe.

**Assumptions shown to the student:** A, B and C fail independently with a made-up probability of 0.1 each. Nothing here describes a real plant.

**Steps**
1. Add three basic events named A, B and C, each with probability 0.1.
   - Hint: The system fails if at least two of the three fail. Name each event in the Name field; the lesson finds your events by their names.
2. Add a voting gate that fails when at least 2 of A, B, C fail. Make it the top event and run with each method.
   - Hint: Use the K-of-N gate button and set K to 2. The gate then fails when at least 2 of its 3 inputs fail.

**Expected results** (each equals an independently checked oracle entry)
- Exact: probability 0.028; cut sets {A, B}, {A, C}, {B, C} (oracle `pra-vote-exact`)
- Rare-event approximation: probability 0.03; cut sets {A, B}, {A, C}, {B, C} (oracle `pra-vote-rare`)
- Min-cut upper bound: probability 0.029701; cut sets {A, B}, {A, C}, {B, C} (oracle `pra-vote-mcub`)

**"Check this" messages**
- A probability above 1 is not allowed. Write 10 percent as 0.1.
- The top gate is not a voting gate. AND needs all three to fail and OR needs only one.

**Hand calculation (shown after the student has run the model)**
- Exact: two or three fail. 3 x 0.1^2 x 0.9 + 0.1^3 = 0.027 + 0.001 = 0.028.
- Rare-event: add the three cut sets, 3 x 0.01 = 0.03. It is above the exact value because it counts overlaps twice.
- Min-cut upper bound: 1 - (1 - 0.01)^3 = 0.029701. Both approximations are close when probabilities are small and drift apart as they grow.

**Reviewer**

- Name and role: 
- Date: 
- Verdict (approved / approved with changes / not approved): 
- Changes asked for: 

