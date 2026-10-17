/**
 * Hook script templates for all supported hook types.
 * On Unix, templates are Bash scripts with comprehensive examples.
 * On Windows, templates are PowerShell scripts executed by the Windows hook runtime.
 */

export function getHookTemplate(hookName: string): string {
	if (process.platform === "win32") {
		return getWindowsPowerShellTemplate(hookName)
	}

	const templates: Record<string, string> = {
		TaskStart: getTaskStartTemplate(),
		TaskResume: getTaskResumeTemplate(),
		TaskCancel: getTaskCancelTemplate(),
		TaskComplete: getTaskCompleteTemplate(),
		PreToolUse: getPreToolUseTemplate(),
		PostToolUse: getPostToolUseTemplate(),
		UserPromptSubmit: getUserPromptSubmitTemplate(),
	}

	return templates[hookName] || getDefaultTemplate(hookName)
}

function getWindowsPowerShellTemplate(hookName: string): string {
	return `# ${hookName} Hook
# PowerShell template for Windows hook execution.

try {
    $rawInput = [Console]::In.ReadToEnd()
    if ($rawInput) {
        $null = $rawInput | ConvertFrom-Json
    }
} catch {
    Write-Error "[${hookName}] Invalid JSON input: $($_.Exception.Message)"
}

@{
    cancel = $false
    contextModification = ""
    errorMessage = ""
} | ConvertTo-Json -Compress
`
}

function getTaskStartTemplate(): string {
	return `#!/bin/bash
#
# TaskStart Hook
# 
# Executes when a new task begins.
# 
# Input: { 
#   taskId, 
#   taskStart: { 
#     taskMetadata: { taskId: string, ulid: string, initialTask: string } 
#   }, 
#   clineVersion, timestamp, ... 
# }
# Output: { cancel: boolean, contextModification?: string, errorMessage?: string }
# 
# Use cases:
# - Log task start time
# - Add context about environment or project state
# - Check prerequisites before starting
# - Notify external systems (Slack, issue trackers, etc.)

# Read JSON input from stdin
INPUT=$(cat)

# Parse input using jq (or fallback to basic parsing)
if command -v jq &> /dev/null; then
  TASK=$(echo "$INPUT" | jq -r '.taskStart.taskMetadata.initialTask')
  TASK_ID=$(echo "$INPUT" | jq -r '.taskId')
  TIMESTAMP=$(echo "$INPUT" | jq -r '.timestamp')
else
  # Fallback if jq is not available
  TASK="<task>"
  TASK_ID="<taskId>"
  TIMESTAMP=$(date +%s%3N)
fi

# Example: Log task start
echo "[TaskStart] Task started: $TASK" >&2
echo "[TaskStart] Task ID: $TASK_ID" >&2

# Example: Add context to the task
TIMESTAMP_ISO=$(date -u -d @"$((TIMESTAMP/1000))" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
CONTEXT_MOD="Note: Task started at $TIMESTAMP_ISO"

# Return result as JSON (use jq to safely encode the variable, with a simple fallback)
if command -v jq &> /dev/null; then
  jq -n --arg ctx "$CONTEXT_MOD" '{"cancel":false,"contextModification":$ctx,"errorMessage":""}'
else
  ESCAPED_MOD=$(printf '%s' "$CONTEXT_MOD" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
  echo '{"cancel":false,"contextModification":"'"$ESCAPED_MOD"'","errorMessage":""}'
fi
`
}

function getTaskResumeTemplate(): string {
	return `#!/bin/bash
#
# TaskResume Hook
# 
# Executes when a task is resumed after being interrupted.
# 
# Input: { 
#   taskId, 
#   taskResume: { 
#     taskMetadata: { taskId: string, ulid: string },
#     previousState: { lastMessageTs: string, messageCount: string, conversationHistoryDeleted: string }
#   }, 
#   clineVersion, timestamp, ... 
# }
# Output: { cancel: boolean, contextModification?: string, errorMessage?: string }
# 
# Use cases:
# - Check for changes since task was paused
# - Refresh context with latest project state
# - Notify that work is resuming

# Read JSON input from stdin
INPUT=$(cat)

# Parse input using jq (or fallback to basic parsing)
if command -v jq &> /dev/null; then
  TASK_ID=$(echo "$INPUT" | jq -r '.taskResume.taskMetadata.taskId')
  MSG_COUNT=$(echo "$INPUT" | jq -r '.taskResume.previousState.messageCount')
else
  TASK_ID="<taskId>"
  MSG_COUNT="0"
fi

echo "[TaskResume] Resuming task: $TASK_ID (previous messages: $MSG_COUNT)" >&2

# Return result
echo '{"cancel":false,"contextModification":"","errorMessage":""}'
`
}

function getTaskCancelTemplate(): string {
	return `#!/bin/bash
#
# TaskCancel Hook
# 
# Executes when a task is cancelled by the user.
# 
# Input: { 
#   taskId, 
#   taskCancel: { 
#     taskMetadata: { taskId: string, ulid: string, completionStatus: string } 
#   }, 
#   clineVersion, timestamp, ... 
# }
# Output: { cancel: boolean, contextModification?: string, errorMessage?: string }
# 
# Use cases:
# - Clean up temporary files or resources
# - Notify external systems about cancellation
# - Log cancellation for analytics

# Read JSON input from stdin
INPUT=$(cat)

# Parse input using jq (or fallback to basic parsing)
if command -v jq &> /dev/null; then
  TASK_ID=$(echo "$INPUT" | jq -r '.taskCancel.taskMetadata.taskId')
  STATUS=$(echo "$INPUT" | jq -r '.taskCancel.taskMetadata.completionStatus')
else
  TASK_ID="<taskId>"
  STATUS="cancelled"
fi

echo "[TaskCancel] Task cancelled: $TASK_ID (status: $STATUS)" >&2

# Return result
echo '{"cancel":false,"contextModification":"","errorMessage":""}'
`
}

function getTaskCompleteTemplate(): string {
	return `#!/bin/bash
#
# TaskComplete Hook
# 
# Executes when a task completes successfully.
# 
# Input: { 
#   taskId, 
#   taskComplete: { 
#     taskMetadata: { taskId: string, ulid: string, result: string, command: string } 
#   }, 
#   clineVersion, timestamp, ... 
# }
# Output: { cancel: boolean, contextModification?: string, errorMessage?: string }
# 
# Use cases:
# - Run tests or validation
# - Generate reports or summaries
# - Notify stakeholders
# - Trigger CI/CD pipelines

# Read JSON input from stdin
INPUT=$(cat)

# Parse input using jq (or fallback to basic parsing)
if command -v jq &> /dev/null; then
  TASK_ID=$(echo "$INPUT" | jq -r '.taskComplete.taskMetadata.taskId')
  RESULT=$(echo "$INPUT" | jq -r '.taskComplete.taskMetadata.result')
else
  TASK_ID="<taskId>"
  RESULT="<result>"
fi

echo "[TaskComplete] Task completed: $TASK_ID (result: $RESULT)" >&2

# Return result
echo '{"cancel":false,"contextModification":"","errorMessage":""}'
`
}

function getPreToolUseTemplate(): string {
	return `#!/bin/bash
#
# PreToolUse Hook
# 
# Executes before any tool is used (read_file, write_to_file, execute_command, etc.)
# 
# Input: { taskId, preToolUse: { toolName: string, parameters: object }, ... }
# Output: { cancel: boolean, contextModification?: string, errorMessage?: string }
# 
# Use cases:
# - Block dangerous operations
# - Add safety checks before file modifications
# - Log tool usage
# - Validate parameters before execution

# Read JSON input from stdin
INPUT=$(cat)

# Parse input using jq (or fallback to basic parsing)
if command -v jq &> /dev/null; then
  TOOL=$(echo "$INPUT" | jq -r '.preToolUse.toolName')
  COMMAND=$(echo "$INPUT" | jq -r '.preToolUse.parameters.command // empty')
else
  TOOL="<tool>"
  COMMAND=""
fi

# Example: Block dangerous operations
if [[ "$TOOL" == "execute_command" ]] && [[ "$COMMAND" == *"rm -rf /"* ]]; then
  echo '{"cancel":true,"errorMessage":"Dangerous command blocked by PreToolUse hook"}'
  exit 0
fi

# Example: Log tool usage
echo "[PreToolUse] Tool about to execute: $TOOL" >&2

# Allow execution
echo '{"cancel":false,"contextModification":"","errorMessage":""}'
`
}

function getPostToolUseTemplate(): string {
	return `#!/bin/bash
#
# PostToolUse Hook
# 
# Executes after any tool is used successfully or fails.
# 
# Input: { 
#   taskId, 
#   postToolUse: { 
#     toolName: string, 
#     parameters: object,
#     result: string,
#     success: boolean,
#     executionTimeMs: number
#   }, 
#   ... 
# }
# Output: { cancel: boolean, contextModification?: string, errorMessage?: string }
# 
# Use cases:
# - Audit tool usage
# - Validate results
# - Trigger follow-up actions
# - Monitor performance

# Read JSON input from stdin
INPUT=$(cat)

# Parse input using jq (or fallback to basic parsing)
if command -v jq &> /dev/null; then
  TOOL=$(echo "$INPUT" | jq -r '.postToolUse.toolName')
  SUCCESS=$(echo "$INPUT" | jq -r '.postToolUse.success')
  DURATION=$(echo "$INPUT" | jq -r '.postToolUse.executionTimeMs')
else
  TOOL="<tool>"
  SUCCESS="true"
  DURATION="0"
fi

# Log tool completion
STATUS="success"
[[ "$SUCCESS" == "false" ]] && STATUS="failed"
echo "[PostToolUse] Tool completed: $TOOL ($STATUS) in \${DURATION}ms" >&2

# Return result
echo '{"cancel":false,"contextModification":"","errorMessage":""}'
`
}

function getUserPromptSubmitTemplate(): string {
	return `#!/bin/bash
#
# UserPromptSubmit Hook
# 
# Executes when the user submits a prompt to Cline.
# 
# Input: { taskId, userPromptSubmit: { prompt: string, attachments: string[] }, clineVersion, timestamp, ... }
# Output: { cancel: boolean, contextModification?: string, errorMessage?: string }
# 
# Use cases:
# - Log user prompts for analytics
# - Add context based on prompt content
# - Validate or sanitize prompts
# - Trigger external integrations

# Read JSON input from stdin
INPUT=$(cat)

# Parse input using jq (or fallback to basic parsing)
if command -v jq &> /dev/null; then
  PROMPT=$(echo "$INPUT" | jq -r '.userPromptSubmit.prompt')
  PROMPT_LENGTH=\${#PROMPT}
else
  PROMPT_LENGTH=0
fi

echo "[UserPromptSubmit] User submitted prompt (length: $PROMPT_LENGTH)" >&2

# Return result
echo '{"cancel":false,"contextModification":"","errorMessage":""}'
`
}

function getDefaultTemplate(hookName: string): string {
	return `#!/bin/bash
#
# ${hookName} Hook
# 
# Input: JSON via stdin
# Output: JSON to stdout

# Read JSON input from stdin
INPUT=$(cat)

# Parse input using jq (or fallback to basic parsing)
if command -v jq &> /dev/null; then
  TASK_ID=$(echo "$INPUT" | jq -r '.taskId')
else
  TASK_ID="<taskId>"
fi

# Your hook logic here
echo "[${hookName}] Executed for task $TASK_ID" >&2

# Return result
echo '{"cancel":false,"contextModification":"","errorMessage":""}'
`
}
