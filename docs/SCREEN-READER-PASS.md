# Screen-reader test script

A human task. Automated checks (axe-core, keyboard-only e2e tests) find some problems and not others; nobody has yet listened to the editor with a screen reader, so the editor must not be called accessible until this has been done and the results recorded below.

**Setup.** Windows with NVDA (free) and Chrome, or VoiceOver with Safari on a Mac. Start the app (`npm start`, then http://127.0.0.1:5205). Turn the monitor off or look away so the test is by ear. Note the screen reader, its version and the browser.

For each step write what was announced and mark **pass** (a person who cannot see the screen could do the step), **partial** or **fail**. Record anything that was announced wrongly, twice, not at all, or in a confusing order.

| # | Do this | It should announce | Result / notes |
|---|---|---|---|
| 1 | Open the page | The title "Untitled model · SNEED"; a heading SNEED | |
| 2 | Tab to the ribbon | A toolbar named "Editor tools"; each button with its name (for example "Undo (Ctrl+Z)") and whether it is disabled | |
| 3 | Tab to the drawing | A group "Fault tree drawing"; the first node as "OR gate G1, 2 inputs, top event" | |
| 4 | Arrow Down, Arrow Right | "Basic event E1, probability 0.1", then "Basic event E2 ..." and that the node is pressed/selected | |
| 5 | Enter on E1 | Focus moves to the Name field, announced with its label | |
| 6 | Type a name, Tab, change the probability to 0.3, Enter | The probability field label "Probability that it fails (0 to 1)"; the node's new label afterwards | |
| 7 | Type 5 in the probability field, Enter | An error announced at once ("5 is outside 0 to 1 ...") and the field marked invalid | |
| 8 | Add an AND gate from the ribbon | The new gate announced when selected; the status bar count changes | |
| 9 | Delete a node, then Ctrl+Z | The undo label in the button; the node returns | |
| 10 | Create a problem (connect a gate to itself with "Add input"); open the Problems tab | The count in the tab name ("Problems, 1 to fix, 0 warnings"); the problem read with its code, message and hint | |
| 11 | Fix it; press Ctrl+Enter | "Running" then "Result is current" announced as a status | |
| 12 | Results tab | Status "completed / complete"; the top probability read with its meaning ("not a frequency"); the cut-set table with column headers | |
| 13 | Choose a cut set | The explanation sentence announced ("The top event occurs if ...") | |
| 14 | Change the model; return to Results | "Out of date" announced | |
| 15 | Ctrl+S | A dialog; focus in its name field; the title announced; Escape closes it | |
| 16 | Lesson tab; start "A single pump" | The lesson title; steps read as "Done / Next / Not yet" in words | |
| 17 | Finish lesson 1 by keyboard | "Lesson complete" announced; the Lesson tab shows "done" | |
| 18 | Do a wrong step (for example probability 0.5 in lesson 2) | The "Check this" message announced | |
| 19 | Compare tab after two runs | Two labelled selects ("Earlier run", "Later run"), the Compare button, then the result: probability change, a table of cut-set differences with headers, the model changes as a list | |

## Record

- Screen reader and version:
- Browser and version:
- Date and tester (name and role):
- Overall verdict (usable by ear / usable with problems / not usable):
- Problems found, each with the step number, what was heard and what should have been heard:

Turn every problem into a TODO item before changing the code, and repeat the failed steps after the fix. Update `docs/EDITOR.md` ("Known gaps") only with this record's verdict.
