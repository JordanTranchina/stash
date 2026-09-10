#!/usr/bin/env python3
"""
prepare_agy_prompt.py

Parses GitHub Actions event payload (issues or issue_comment),
verifies user authorization, prepares the prompt for the Antigravity CLI,
and outputs workflow environment variables.
"""

import json
import os
import re
import sys

def main():
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path or not os.path.exists(event_path):
        print("Error: GITHUB_EVENT_PATH not set or file does not exist", file=sys.stderr)
        sys.exit(1)

    with open(event_path, "r", encoding="utf-8") as f:
        event = json.load(f)

    allowed_associations = os.environ.get(
        "ALLOWED_ASSOCIATIONS", "OWNER,MEMBER,COLLABORATOR"
    ).split(",")
    allowed_associations = [a.strip().upper() for a in allowed_associations if a.strip()]

    issue = event.get("issue", {})
    issue_number = issue.get("number")
    issue_title = issue.get("title", "")
    issue_body = issue.get("body", "") or "No description provided."

    comment = event.get("comment")
    if comment:
        author = comment.get("user", {}).get("login", "")
        author_association = comment.get("author_association", "NONE").upper()
        author_type = comment.get("user", {}).get("type", "User")
        trigger_body = comment.get("body", "")
        comment_id = comment.get("id")
        reaction_target = f"issues/comments/{comment_id}"
    else:
        author = issue.get("user", {}).get("login", "")
        author_association = issue.get("author_association", "NONE").upper()
        author_type = issue.get("user", {}).get("type", "User")
        trigger_body = issue_body
        comment_id = None
        reaction_target = f"issues/{issue_number}"

    # Verify not a bot
    if author_type.lower() == "bot" or "[bot]" in author.lower():
        print(f"Skipping: trigger from bot user '{author}'")
        set_output("should_run", "false")
        set_output("authorized", "false")
        return

    # Verify authorization
    is_authorized = author_association in allowed_associations
    if not is_authorized:
        print(
            f"Security warning: User '{author}' has association '{author_association}' "
            f"which is not in allowed list ({allowed_associations})."
        )
        set_output("should_run", "false")
        set_output("authorized", "false")
        set_output("author", author)
        set_output("issue_number", str(issue_number))
        return

    # Check for keyword trigger (/gemini or /agy)
    cmd_pattern = re.compile(r"(?:/gemini|/agy)\s*(.*)", re.IGNORECASE | re.DOTALL)
    match = cmd_pattern.search(trigger_body)

    if not match and "/gemini" not in trigger_body.lower() and "/agy" not in trigger_body.lower():
        print("Skipping: trigger command keyword (/gemini or /agy) not found.")
        set_output("should_run", "false")
        set_output("authorized", "true")
        return

    raw_command_args = match.group(1).strip() if match else trigger_body.strip()

    # Construct clean, comprehensive prompt for agy
    prompt_lines = [
        "You are operating as an automated GitHub AI assistant (Antigravity) running directly in the repository workspace.",
        "",
        "### GitHub Context",
        f"- **Issue #{issue_number}**: {issue_title}",
        f"- **Triggered by**: @{author}",
        "",
        "### Original Issue Description",
        issue_body,
        "",
    ]

    if comment:
        prompt_lines.extend([
            "### User Request / Comment",
            trigger_body,
            "",
        ])
    elif raw_command_args:
        prompt_lines.extend([
            "### Specific Instructions",
            raw_command_args,
            "",
        ])

    prompt_lines.extend([
        "### Instructions",
        "1. Carefully analyze the issue, repository structure, and relevant files.",
        "2. Be concise, targeted, and direct: inspect only the specific files relevant to this issue to resolve it efficiently.",
        "3. If this issue requests a bug fix, feature, or code changes, implement the required changes directly by modifying the repository files.",
        "4. Run appropriate verification/tests if available to ensure your changes work and do not introduce regressions.",
        "5. Provide a clear, structured summary of your analysis, what changes you made (if any), and any considerations or follow-up recommendations.",
        "6. You are strictly forbidden from attempting to merge pull requests or pushing directly to protected/default branches.",
        "",
    ])

    prompt_content = "\n".join(prompt_lines)

    prompt_path = os.environ.get("PROMPT_FILE", "prompt.txt")
    with open(prompt_path, "w", encoding="utf-8") as f:
        f.write(prompt_content)

    print(f"Generated {prompt_path} ({len(prompt_content)} characters) for Issue #{issue_number}")

    # Set outputs for GitHub Actions
    set_output("should_run", "true")
    set_output("authorized", "true")
    set_output("issue_number", str(issue_number))
    # Sanitize title for branch name
    clean_title = re.sub(r"[^\w\s-]", "", issue_title).strip()
    clean_title = re.sub(r"[-\s]+", "-", clean_title)[:40].lower().strip("-")
    if not clean_title:
        clean_title = "fix"
    set_output("clean_title", clean_title)
    set_output("issue_title", issue_title)
    set_output("reaction_target", reaction_target)
    set_output("author", author)

def set_output(name, value):
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as f:
            f.write(f"{name}={value}\n")
    print(f"[OUTPUT] {name}={value}")

if __name__ == "__main__":
    main()
