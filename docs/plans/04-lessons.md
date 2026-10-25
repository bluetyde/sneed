# Plan 04: Lessons

*Lesson 5, "Pumps that fail together" (common-cause groups, plan 15) was added 2026-10-25; see [EDITOR.md](../EDITOR.md).*

Three guided lessons and the rules for writing more. Milestone P3. Probabilities are synthetic and labelled so; none represents a real plant.

## Lesson format

Each lesson is a data file: title, learning goals, ordered steps, a starting model, expected results with tolerance, hints, and common mistakes. Steps check the student's model against structure and values (for example "your top gate is an AND") and never grade a drawing's position. Every number shown is checkable by hand, and the lesson shows the hand calculation after the student has tried.

## Lesson 1: a single pump

Goal: events, a top event and a probability. Model: top event "No coolant flow", one basic event "Pump P fails", p = 0.1.
Expected: top probability 0.1; one cut set {P}.
Mistakes to catch: probability entered as a percentage (10), a gate with one input where an event would do.

## Lesson 2: redundant pumps

Goal: AND and OR, and what redundancy buys. Model: two pumps, either one suffices. Top event "No coolant flow" = P1 AND P2, p = 0.1 each.
Expected: 0.01; one cut set {P1, P2} of order 2. Student then changes the logic to OR ("either pump failure stops flow") and sees 0.19, with cut sets {P1}, {P2}, to learn that the same events give different answers under different logic.
Hand calculation: AND is the product, OR is 1 − (1 − p)².
Assumption shown: P1 and P2 are independent.

## Lesson 3: redundant pumps with a shared power supply

Goal: common causes and repeated events. Model: top = S OR (P1 AND P2), where S is "Power supply fails" with p = 0.05 and feeds both pumps; P1 and P2 p = 0.1.
Expected: 0.0595; cut sets {S}, {P1, P2}. Without S the redundant pair gives 0.01, so the shared supply makes the system about six times worse than the pair alone suggests.
Teaching point: the single event S dominates. Each pump fails if it fails itself or loses power, so the tree is (P1 OR S) AND (P2 OR S), with S one event under both pumps. The student then redraws it with two separate events S1 and S2 (each 0.05), which is the same picture with different identities: (P1 OR S1) AND (P2 OR S2) = (1 - 0.95 x 0.9)^2 = 0.021025. Reusing one event gives 0.0595, two independent copies give 0.021025; the lesson asks which one matches a single shared supply, and shows that repeated-event identity changes the answer by about a factor of three.
Hand calculation: P(S) + P(P1 P2) − P(S) P(P1 P2).

## Optional lesson 4: voting (if a K-of-N gate is adopted)

2-of-3 with p = 0.1: exact 0.028; rare-event 0.03; min-cut upper bound 0.029701. Teaching point: approximations, and when they are safe (small p).

## Rules for lesson content

- Synthetic probabilities, each labelled; any sourced number carries a citation and its conditions.
- No lesson states or implies plant risk, a frequency, or a safety conclusion.
- A lesson's expected values are oracle entries ([plan 05](05-verification.md)); a lesson cannot ship with a value that is not checked independently.
- Plain language first; the formal term follows. Alt text for every figure.
- A lesson works with no SEED and no internet.

## Tests

- Each lesson's expected values equal the oracle entries and the engine's output.
- Each "common mistake" check fires on a fixture of that mistake.
- A lesson runs end to end in the browser with keyboard only.
- Lesson files with a missing oracle reference fail validation.

## Open

- How many more lessons before release. (The three event-tree lessons were built 2026-10-07: see [plan 13](13-event-trees.md) and docs/EDITOR.md. They follow these rules.)
- Whether to include a short instructor guide with answers and discussion questions.
- Language and reading level; review by an instructor before release.
