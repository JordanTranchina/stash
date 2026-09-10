#!/usr/bin/env python3
"""
post_agy_result.py

Formats the output from Antigravity CLI (agy), integrates any draft PR details,
and writes a markdown comment ready to be posted to the GitHub Issue thread.
Handles character limits to ensure comments comply with GitHub API limits.
"""

import os
import sys

MAX_COMMENT_LENGTH = 60000  # GitHub limit is 65,536 characters

def truncate_text(text, max_len=50000):
    if len(text) <= max_len:
        return text
    half = max_len // 2 - 100
    return (
        text[:half]
        + "\n\n... [Output truncated to respect GitHub comment size limits] ...\n\n"
        + text[-half:]
    )

def main():
    run_status = os.environ.get("RUN_STATUS", "success")
    authorized = os.environ.get("AUTHORIZED", "true").lower() == "true"
    author = os.environ.get("AUTHOR", "User")
    pr_url = os.environ.get("PR_URL", "").strip()
    issue_number = os.environ.get("ISSUE_NUMBER", "")
    output_file = os.environ.get("OUTPUT_FILE", "agy_output.txt")
    comment_file = os.environ.get("COMMENT_FILE", "comment_body.md")

    lines = []

    if not authorized:
        lines.append("### ⚠️ Antigravity Trigger Notice")
        lines.append(
            f"Hello @{author}, the Antigravity agent was not executed because this repository requires "
            f"`OWNER`, `MEMBER`, or `COLLABORATOR` permissions to run unattended CLI commands."
        )
        with open(comment_file, "w", encoding="utf-8") as f:
            f.write("\n\n".join(lines))
        return

    agy_output = ""
    if os.path.exists(output_file):
        with open(output_file, "r", encoding="utf-8", errors="replace") as f:
            agy_output = f.read().strip()

    if not agy_output:
        agy_output = "No textual output produced by the Antigravity CLI."

    truncated_output = truncate_text(agy_output)

    if run_status == "failure":
        lines.append("### ❌ Antigravity Execution Failed")
        lines.append("The Antigravity CLI encountered an error while processing your request.")
        lines.append("<details><summary><b>View Error Logs</b></summary>\n")
        lines.append("```\n" + truncated_output + "\n```")
        lines.append("</details>")
    else:
        lines.append("### 🤖 Antigravity Agent Result")
        if pr_url:
            lines.append(
                f"I investigated the request and applied fixes to resolve this issue!\n\n"
                f"👉 **Draft Pull Request**: [{pr_url}]({pr_url})"
            )
            lines.append(
                "<details open><summary><b>CLI Summary</b></summary>\n\n"
                + truncated_output
                + "\n\n</details>"
            )
        else:
            lines.append(truncated_output)

    final_body = "\n\n".join(lines)
    if len(final_body) > MAX_COMMENT_LENGTH:
        final_body = final_body[:MAX_COMMENT_LENGTH] + "\n\n... [Comment truncated]"

    with open(comment_file, "w", encoding="utf-8") as f:
        f.write(final_body)

    print(f"Generated {comment_file} successfully.")

if __name__ == "__main__":
    main()
