#!/bin/bash

# 1. Configuration
BRANCH_NAME="REPLACEWITHSCHEDULENAME"
FILE_PATH="production/scaling_schedules/api_disconnect_gacha_login_tmt.yaml"

# Move to repo and refresh
cd ~/kbm-devspc/mcoc-production/ || exit
git checkout master
git pull

# 2. Switch to a new branch
git checkout -b "$BRANCH_NAME"

# 3. APPEND to the file (Using >> instead of >)
# We add a leading newline to ensure clean separation from existing content
cat <<'EOF' >> "$FILE_PATH"

# big sale
- name                  : REPLACEWITHSCHEDULENAME
  schedule              : REPLACEWITHUSERINPUTSCHEDULE
  duration_sec          : REPLACEWITHUSERINPUTDURATION
  min_required_replicas : ${sch_high}
  time_zone             : Etc/UTC
EOF

# 4. Add, Commit, and Push
git add "$FILE_PATH"
git commit -m "feat: append big sale scaling schedule"
git push origin "$BRANCH_NAME"

# 5. Create PR and capture link
echo "--------------------------------"
echo "Creating Pull Request..."
PR_LINK=$(gh pr create --fill 2>&1 | grep -o "https://github.com[^ ]*" | head -1)

# 6. Final Output
echo "Done! Your PR link is:"
if [ -n "$PR_LINK" ]; then
  echo "$PR_LINK"
else
  echo "ERROR: PR link not found in gh pr create output"
  gh pr create --fill 2>&1
fi