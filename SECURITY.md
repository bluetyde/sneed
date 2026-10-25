# Security policy

SNEED is an experimental teaching tool. It is not validated for safety, licensing or operation. See the status line in the [README](README.md).

## What to report

Report a problem if SNEED can do any of these with a crafted input:

- Read or write a file outside the folders it is told to use.
- Run a program or a shell command that the user did not ask for.
- Hang, crash or use all memory because of a hostile model, event tree or Open-PSA XML file.
- Show a failed, cancelled or incomplete analysis as a complete result.
- Leak a user name or a local path into a saved result.

A wrong number from a valid model is also worth a report. Open a normal issue for it.

## How to report

Use GitHub private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not post details in a public issue before a fix exists.

Give the SNEED commit, the Node.js version, the input that causes the problem and what you expected to happen.

## What to expect

This is a small project with no support contract. The maintainer reads reports and answers when possible. There is no set response time.

## Supported versions

Only the latest commit on the default branch gets fixes.

## Scope notes

- SCRAM is a separate program, built on the user's machine. A defect in SCRAM itself belongs in the [SCRAM project](https://github.com/rakhimov/scram). Report it to SNEED only if SNEED shows the wrong result without a warning.
- The server is meant to run on the local machine for one user. It has no sign-in. Do not expose it to a network.
