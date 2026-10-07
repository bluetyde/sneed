# Event-tree lesson review sheet and instructor guide

Generated from `lessons/event-trees/*.json` by `node scripts/lesson-review.mjs`. Regenerate after any change to a lesson, because a sign-off applies to the text below and nothing else. The fault-tree lessons have their own sheet, [LESSON-REVIEW.md](LESSON-REVIEW.md).

The reviewer is the course instructor or another subject-matter reader, not the author of the lessons. A mechanical readability score and the author's own read are not a review. **The instructor's questions and model answers below are never sent to the student's browser.**

## What to check in each lesson

1. Is every statement true, including the hand calculations and the numbers in the expected results?
2. Does anything state or imply a real plant, a safety conclusion or a licensing judgement? (Every end state a student names is theirs, and the tool marks examples as examples.)
3. Is the wording right for the students (reading level, jargon introduced after plain language)?
4. Does each step say what a student must do, in the words the editor uses?
5. Does each "check this" message teach the right thing without giving the answer away?
6. The shared-event lesson asks for a prediction BEFORE the analysis and then shows the product of the two failure probabilities beside the exact value. Is that the comparison you want to teach, and is "about a third too low" (the product is 32.7 percent below the exact value) fair wording?
7. Are the instructor's questions and model answers right, and enough for a short discussion?

## An event tree by hand: two independent safety functions

File: `lessons/event-trees/01-independent-headings.json`

**Goals**
- Read an event tree: one initiating event, headings that work or fail, and sequences that end in named end states.
- Find the frequency of each sequence by multiplying along its path, and see that the frequencies add up to the frequency of the initiating event.

**Assumptions shown to the student:** All numbers are made up for teaching. The initiating event happens 0.1 times per year. The heading "Injection" fails with probability 0.01 each time it is asked, and "Cooling" with probability 0.1. The two are independent. The end states you name are examples, not conditions of any real plant. A frequency here is a result of this model under these assumptions, not a plant figure.

**The fault-tree model the lesson saves for the student** (as `lesson-et-independent`): top event `TOP`.
- basic event `INJ` (Injection fails): probability 0.01
- basic event `COOL` (Cooling fails): probability 0.1
- gate `TOP` (Either fails): OR of `INJ`, `COOL`

**Steps**
1. Set the frequency of the initiating event to 0.1 per year.
   - Hint: Use the Frequency field under "Initiating event". It is a number of events per year.
2. Make heading 1 fail when INJ occurs and name it Injection. Add a second heading that fails when COOL occurs and name it Cooling.
   - Hint: Use the list "Fails when this occurs" in each row of the Headings table, and the button "Add a heading". The order matters: Injection acts first.
3. Look at the Sequences table. Two headings that each work or fail give four paths. Check that it lists four.
   - Hint: Each heading doubles the number of paths, because every earlier path can continue in two ways.
4. Add end states until you have three: one for "everything worked", one for "one heading failed" and one for "both failed". Name each one so that it says it is an example.
   - Hint: Use "Add an end state". Names such as "Safe (example)" are fine. The tool never fills in a name that sounds like a real plant condition.
5. Choose an end state for each of the four sequences.
   - Hint: The list "Ends in" in each row of the Sequences table. Think about how many headings failed on the path.

**Expected results** (each equals an independently checked oracle entry, re-derived by exact enumeration in the tests)
- Two independent headings at 0.1 per year (oracle `et-independent`), frequency of each sequence per year:
  - INJ works, COOL works: 0.0891
  - INJ works, COOL fails: 0.0099
  - INJ fails, COOL works: 0.0009
  - INJ fails, COOL fails: 0.0001

**"Check this" messages**
- Two headings fail on the same event. Each heading should be a different safety function with its own event.
- A heading fails when ITS event occurs. TOP is the event that either one fails, which is not one safety function. Choose INJ for one heading and COOL for the other.
- A frequency of 0 makes every sequence frequency 0. The initiating event happens 0.1 times per year here.

**Hand calculation (shown after the student has analysed the tree)**
- A sequence frequency is the frequency of the initiating event times the probability of every branch on its path. Injection works with probability 1 - 0.01 = 0.99, and Cooling works with probability 1 - 0.1 = 0.9.
- Both work: 0.1 x 0.99 x 0.9 = 0.0891 per year. Injection works, Cooling fails: 0.1 x 0.99 x 0.1 = 0.0099. Injection fails, Cooling works: 0.1 x 0.01 x 0.9 = 0.0009. Both fail: 0.1 x 0.01 x 0.1 = 0.0001.
- The four add up to 0.1 per year, the frequency of the initiating event: every time it happens, exactly one sequence follows. The tool checks this and refuses a table that does not add up.
- Your end states add sequences together. If "one failed" collects both middle paths, its frequency is 0.0099 + 0.0009 = 0.0108 per year.

**For the instructor: discussion questions and model answers (not shown to students)**
- Question: Why must the frequencies of all sequences add up to the frequency of the initiating event?
  - Model answer: Each occurrence of the initiating event is followed by exactly one path through the tree, so the paths partition the possible outcomes.
- Question: Why does the "both failed" frequency (0.0001) equal the product of the two failure probabilities times the initiating frequency here?
  - Model answer: Because the two headings were declared independent: they share no basic event. The next lesson shows what changes when they do.
- Question: What would you need to know before using such a number for any real system?
  - Model answer: Where the probabilities and the frequency come from, whether the headings really are independent, whether anything else can happen after the initiating event, and what the end states mean physically. None of that is in this model.

**Reviewer**

- Name and role: 
- Date: 
- Verdict (approved / approved with changes / not approved): 
- Changes asked for: 

## When two safety functions share a cause

File: `lessons/event-trees/02-shared-event.json`

**Goals**
- See that two headings which depend on the same basic event do not fail independently.
- Predict the frequency of "both fail" first, then compare it with the exact value and with the product of the two failure probabilities.

**Assumptions shown to the student:** All numbers are made up for teaching. The initiating event happens 0.5 times per year. A shared support system S fails with probability 0.1. Injection fails if S fails or the injection pump fails (0.2). Cooling fails if S fails or the cooling pump fails (0.3). The tool treats S as ONE event used by both headings. The end states you name are examples, not conditions of any real plant. A frequency here is a result of this model under these assumptions, not a plant figure.

**The fault-tree model the lesson saves for the student** (as `lesson-et-shared`): top event `TOP`.
- basic event `S` (Shared support fails): probability 0.1
- basic event `a` (Injection pump fails): probability 0.2
- basic event `b` (Cooling pump fails): probability 0.3
- gate `X` (Injection fails): OR of `S`, `a`
- gate `Y` (Cooling fails): OR of `S`, `b`
- gate `TOP` (Both fail): AND of `X`, `Y`

**Steps**
1. Set the frequency of the initiating event to 0.5 per year.
   - Hint: Use the Frequency field under "Initiating event".
2. Make heading 1 fail when X ("Injection fails") occurs and name it Injection. Make heading 2 fail when Y ("Cooling fails") occurs and name it Cooling.
   - Hint: X and Y are gates of the model. Both of them contain the basic event S, so both headings can be caused by the same failure.
3. Type your prediction in the box "Your prediction" in the lesson panel.
   - Hint: You can reason with the numbers in the assumptions: how likely is each heading to fail on its own, and what would you get by multiplying?
4. Give every sequence an end state. One end state for all of them is enough for this lesson.
   - Hint: Use "Give them all" above the Sequences table, or the list in each row.

**Prediction asked before the analysis:** Before you analyse: how often per year do you expect BOTH headings to fail? Type your guess. There is no wrong guess; you will see it next to the result.

**Expected results** (each equals an independently checked oracle entry, re-derived by exact enumeration in the tests)
- Injection and Cooling share the support system S (oracle `et-shared`), frequency of each sequence per year:
  - X works, Y works: 0.252
  - X works, Y fails: 0.108
  - X fails, Y works: 0.063
  - X fails, Y fails: 0.077

**"Check this" messages**
- Two headings fail on the same event. Injection is the gate X and Cooling is the gate Y.
- TOP is the event that both fail at once. A heading is ONE safety function: use X for Injection and Y for Cooling, and let the tree work out what happens when both fail.
- A frequency of 0 makes every sequence frequency 0. The initiating event happens 0.5 times per year here.

**Hand calculation (shown after the student has analysed the tree)**
- Injection fails with probability P(X) = 1 - (1 - 0.1)(1 - 0.2) = 0.28. Cooling fails with probability P(Y) = 1 - (1 - 0.1)(1 - 0.3) = 0.37.
- The product of the two, 0.28 x 0.37 = 0.1036, would be right only if the headings were independent. They are not: when S fails, both fail together.
- Exactly: both fail if S fails, or if S works and both pumps fail. 0.1 + 0.9 x 0.2 x 0.3 = 0.154. Times 0.5 per year that is 0.077 per year; the product would give 0.0518 per year, about a third too low.
- The other sequences: both work 0.9 x 0.8 x 0.7 = 0.504 (0.252 per year); Injection fails and Cooling works 0.9 x 0.2 x 0.7 = 0.126 (0.063 per year); Injection works and Cooling fails 0.9 x 0.8 x 0.3 = 0.216 (0.108 per year). The four probabilities add up to 1.

**For the instructor: discussion questions and model answers (not shown to students)**
- Question: Which of the two numbers would you have trusted without the shared support system in the picture: the product, or the exact value? Why is the product too low?
  - Model answer: The product treats the failures as unrelated. S makes them travel together, so "both fail" is more likely than the product says.
- Question: In the model, how does the tool know the two headings share S?
  - Model answer: Both headings refer to gates of ONE fault-tree model, and S is one basic event inside both gates. If the author had drawn two separate events called S1 and S2, the tool would have treated them as unrelated.
- Question: Which assumption of this lesson would you most want to check for a real system?
  - Model answer: Independence of the basic events other than S, and whether S really is the only shared cause. Neither can be checked by the tool.

**Reviewer**

- Name and role: 
- Date: 
- Verdict (approved / approved with changes / not approved): 
- Changes asked for: 

## A heading that is not always asked

File: `lessons/event-trees/03-bypass.json`

**Goals**
- Make a heading that is asked only after an earlier heading has worked, and see that its paths are left out where it is not asked.
- See that the sequence frequencies still add up to the frequency of the initiating event.

**Assumptions shown to the student:** All numbers are made up for teaching. The initiating event happens 0.5 times per year. Same shared support system as the previous lesson: S fails with probability 0.1, the injection pump with 0.2, the cooling pump with 0.3. Here Cooling is asked only if Injection worked. The end states you name are examples, not conditions of any real plant. A frequency here is a result of this model under these assumptions, not a plant figure.

**The fault-tree model the lesson saves for the student** (as `lesson-et-shared`): top event `TOP`.
- basic event `S` (Shared support fails): probability 0.1
- basic event `a` (Injection pump fails): probability 0.2
- basic event `b` (Cooling pump fails): probability 0.3
- gate `X` (Injection fails): OR of `S`, `a`
- gate `Y` (Cooling fails): OR of `S`, `b`
- gate `TOP` (Both fail): AND of `X`, `Y`

**Steps**
1. Set the frequency of the initiating event to 0.5 per year.
   - Hint: Use the Frequency field under "Initiating event".
2. Make heading 1 fail when X occurs (Injection) and heading 2 fail when Y occurs (Cooling).
   - Hint: Use the list "Fails when this occurs" in each row of the Headings table.
3. In the column "Asked" of the Cooling row, choose "Only if Injection works".
   - Hint: The list offers the earlier headings and the branch each must have taken.
4. Look at the Sequences table. Where Injection fails, Cooling is not asked, so that path has no Cooling branch. Check that there are three sequences.
   - Hint: Injection works leads to two paths (Cooling works or fails); Injection fails leads to one.
5. Give every sequence an end state.
   - Hint: Use "Give them all" above the Sequences table, or the list in each row.

**Expected results** (each equals an independently checked oracle entry, re-derived by exact enumeration in the tests)
- Cooling asked only if Injection worked (oracle `et-bypass`), frequency of each sequence per year:
  - X works, Y works: 0.252
  - X works, Y fails: 0.108
  - X fails: 0.14

**"Check this" messages**
- Two headings fail on the same event. Injection is the gate X and Cooling is the gate Y.
- TOP is the event that both fail at once. A heading is ONE safety function: use X for Injection and Y for Cooling.
- Cooling is asked only when Injection WORKED. You chose the other branch, which would ask for Cooling only after Injection failed.
- A frequency of 0 makes every sequence frequency 0. The initiating event happens 0.5 times per year here.

**Hand calculation (shown after the student has analysed the tree)**
- Where Injection works and Cooling is asked: both work 0.9 x 0.8 x 0.7 = 0.504, and Cooling fails 0.9 x 0.8 x 0.3 = 0.216. Times 0.5 per year: 0.252 and 0.108.
- Where Injection fails, Cooling is not asked, so that sequence has no Cooling branch: its probability is just the probability that Injection fails, 1 - 0.8 x 0.9 = 0.28, and 0.28 x 0.5 = 0.14 per year.
- The three add up to 0.504 + 0.216 + 0.28 = 1 and to 0.5 per year. A path that is left out must not leave a gap: the tool refuses a sequence list that does not cover every case exactly once.

**For the instructor: discussion questions and model answers (not shown to students)**
- Question: In a real system, when would a safety function not be asked at all after another one failed?
  - Model answer: For example when the later function depends on the earlier one so that asking it would be meaningless or when the procedure goes straight to another response. The tool only records that the heading is not asked; whether that is right for a real system is an engineering judgement.
- Question: Why is the "Injection fails" sequence 0.28 and not 0.28 x (something about Cooling)?
  - Model answer: Cooling is not asked on that path, so it contributes no branch. The sequence covers every case in which Injection fails, whatever Cooling would have done.

**Reviewer**

- Name and role: 
- Date: 
- Verdict (approved / approved with changes / not approved): 
- Changes asked for: 

