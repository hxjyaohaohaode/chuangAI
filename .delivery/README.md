# Candidate source delivery

This directory is a transport staging area for the independently rewritten v6 candidate. The main branch and original files remain unchanged. A forthcoming manifest identifies each payload chunk and expanded source by SHA-256. The unpacker must validate all paths and hashes before writing only under v6. No runtime database, credentials, uploads, private configuration, or student data belongs here.

The candidate-only workflow uses pinned official actions, expands the local source package, runs the actual Node regression on Node 24, and commits readable source plus its real evidence to the same branch. No force-push and no main-branch merge. A configured workflow is not evidence of a successful run. See the eventual v6 test report for browser, real-provider, Windows, migration, and legacy-feature limitations.
