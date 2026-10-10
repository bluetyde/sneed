#!/bin/sh
# For `git filter-branch --tree-filter`, in a SCRATCH CLONE only (see docs/PUBLICATION.md, "History"). Replaces an account name and a folder name
# in every text file of every commit. The names are arguments, so this file never holds them:
#   FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --tree-filter "sh /path/to/history-scrub-tree-filter.sh ACCOUNT FOLDER_NAME" -- --all
# FOLDER_NAME is written with single spaces ("My Folder"); its URL-encoded spelling ("My%20Folder") is replaced too.
account="$1"
folder="$2"
[ -z "$account" ] || [ -z "$folder" ] && { echo "usage: history-scrub-tree-filter.sh ACCOUNT FOLDER_NAME" >&2; exit 2; }
enc=$(printf '%s' "$folder" | sed 's/ /%20/g')
files=$(grep -rlI -F -e "$account" -e "$folder" -e "$enc" . 2>/dev/null | grep -v '^\./\.git/')
[ -z "$files" ] && exit 0
# escape the names for sed (they are plain text, not patterns)
esc() { printf '%s' "$1" | sed 's/[][\.*^$/&|(){}+?]/\\&/g'; }
a=$(esc "$account"); f=$(esc "$folder"); e=$(esc "$enc")
echo "$files" | while IFS= read -r file; do
  sed -i -e "s/$a/user/g" -e "s/$e/workspace/g" -e "s/$f/workspace/g" "$file"
done
exit 0
