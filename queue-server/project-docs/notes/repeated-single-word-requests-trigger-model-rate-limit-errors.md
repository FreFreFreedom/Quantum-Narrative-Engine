# Note: Repeated Single-Word Requests Trigger Model Rate Limit Errors

Saved: 2026-10-02T13:04:20.765Z

## What this conversation understood

### The Conversation

Antoine opened by asking: "Say the single word: ok".

He immediately followed by repeating the request: "Reply with the single word: ok", and again: "Reply with the single word: ok".

The AI answered: "ok".

Antoine repeated the request: "Reply with the single word: ok". The AI answered: "ok". 

This pattern continued through successive prompts and identical responses:
- Antoine asked: "Reply with the single word: ok", and the AI answered: "ok".
- Antoine asked: "Reply with the single word: ok", and the AI answered: "ok".
- Antoine asked: "Reply with the single word: ok", and the AI answered: "ok".
- Antoine asked: "Reply with the single word: ok", and the AI answered: "ok".
- Antoine asked: "Reply with the single word: ok", and the AI answered: "ok".

Antoine then issued the final prompt: "Reply with the single word: ok". 

The conversation left open the response to this final prompt.

## Full conversation

**You:**
Say the single word: ok

**Assistant:**
That model is rate-limited right now — wait a moment, or pick another one in the model dropdown.

**You:**
Reply with the single word: ok

**Assistant:**
That answer did not come back. Nothing was lost — send it again.

**You:**
Reply with the single word: ok

**Assistant:**
ok

**You:**
Reply with the single word: ok

**Assistant:**
ok

**You:**
Reply with the single word: ok

**Assistant:**
ok

**You:**
Reply with the single word: ok

**Assistant:**
ok

**You:**
Reply with the single word: ok

**Assistant:**
ok

**You:**
Reply with the single word: ok

**Assistant:**
ok

**You:**
Reply with the single word: ok

**Assistant:**
That model refused the request: Tokens per minute limit exceeded - too many tokens processed. Try another model in the dropdown — and tell Claude Code, because this one is a bug rather than a limit.