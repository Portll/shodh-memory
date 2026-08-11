#!/bin/bash
# Shodh Memory - Session Start Hook
# Loads proactive context at session start

SHODH_API_URL="${SHODH_API_URL:-http://127.0.0.1:3030}"
SHODH_USER_ID="${SHODH_USER_ID:-claude-code}"

# Resolve API key: env > shared key file persisted by the MCP server > legacy dev key.
# The shared file lives at <data-root>/.api-key (see mcp-server/api-key-store.ts);
# the data root mirrors the Rust server's default_storage_path (src/config.rs).
if [ -z "$SHODH_API_KEY" ]; then
    for KEY_FILE in \
        ${SHODH_MEMORY_PATH:+"$SHODH_MEMORY_PATH/.api-key"} \
        "${XDG_DATA_HOME:-$HOME/.local/share}/shodh-memory/.api-key" \
        "$HOME/Library/Application Support/shodh-memory/.api-key" \
        ${APPDATA:+"$APPDATA/shodh-memory/.api-key"}; do
        if [ -f "$KEY_FILE" ]; then
            SHODH_API_KEY=$(tr -d '[:space:]' < "$KEY_FILE")
            if [ -n "$SHODH_API_KEY" ]; then break; fi
        fi
    done
fi
# Last resort: legacy dev key (only valid when the server was started with it).
# A wrong key is reported loudly below instead of failing silently.
SHODH_API_KEY="${SHODH_API_KEY:-sk-shodh-dev-local-testing-key}"

# Get project directory for context
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
PROJECT_NAME=$(basename "$PROJECT_DIR")

# Build context from recent git activity and current directory
CONTEXT="Working in: $PROJECT_NAME"
if [ -d "$PROJECT_DIR/.git" ]; then
    RECENT_FILES=$(cd "$PROJECT_DIR" && git diff --name-only HEAD~5 2>/dev/null | head -10 | tr '\n' ', ')
    if [ -n "$RECENT_FILES" ]; then
        CONTEXT="$CONTEXT. Recently modified: $RECENT_FILES"
    fi
fi

# Query proactive context from brain, capturing the HTTP status so an auth
# failure is reported LOUDLY instead of memory dying silently for the session.
RESPONSE_FILE=$(mktemp)
trap 'rm -f "$RESPONSE_FILE"' EXIT
HTTP_CODE=$(curl -s -o "$RESPONSE_FILE" -w "%{http_code}" -X POST "$SHODH_API_URL/api/proactive_context" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $SHODH_API_KEY" \
    -d "{
        \"user_id\": \"$SHODH_USER_ID\",
        \"context\": \"$CONTEXT\",
        \"max_results\": 5,
        \"auto_ingest\": false
    }" 2>/dev/null)

if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
    echo "[shodh] ============================================================" >&2
    echo "[shodh] MEMORY CAPTURE DISABLED - server rejected API key ($HTTP_CODE)" >&2
    echo "[shodh] Set SHODH_API_KEY to the key the server was started with, or" >&2
    echo "[shodh] connect the shodh-memory MCP server once so it persists the" >&2
    echo "[shodh] shared key file (<data-dir>/.api-key) that hooks read." >&2
    echo "[shodh] ============================================================" >&2
    echo "{\"systemMessage\": \"shodh-memory: capture DISABLED - the memory server rejected the hook's API key ($HTTP_CODE). Set SHODH_API_KEY or connect the MCP server once to create the shared key file.\"}"
    exit 0
fi

RESPONSE=$(cat "$RESPONSE_FILE")

# Extract memories if response is valid
MEMORIES=$(echo "$RESPONSE" | jq -r '.memories[]? | "- [\(.memory_type)] \(.content | .[0:200])"' 2>/dev/null)

if [ -n "$MEMORIES" ] && [ "$MEMORIES" != "null" ]; then
    # Write to CLAUDE.local.md for automatic injection
    cat > "$PROJECT_DIR/.claude/memory-context.md" << EOF
# Proactive Memory Context

The following memories from past sessions may be relevant:

$MEMORIES

Use these to maintain continuity. If they conflict with current instructions, prioritize current.
EOF
    echo "Loaded $(echo "$MEMORIES" | wc -l) memories from brain"
fi
