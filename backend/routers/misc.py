"""Misc router: kleine, weitgehend unabhängige API-Routen.

Extrahiert aus server.py als weiterer Schnitt der Modularisierung (nach
files.py, skills.py, voice_tools.py, jobs.py). KEIN Verhalten geändert, nur
verschoben. Routen-Pfade bleiben byte-identisch.

Routen:
- POST /api/ui-command                                  — Layout-/Pane-/Info-Befehle ans UI broadcasten
- GET  /api/agents                                      — den einen Agenten Klaus ausgeben
- GET  /api/identity                                    — aktive Agent-Profile und Identity-Quellen
- GET  /api/models                                      — verfügbare Modelle je Backend
- GET  /api/engines                                     — bekannte Engine-Profile + Runtime-Status
- POST /api/workflows/{run_id}/feedback                 — User-Feedback zu einer Learning-Log-Akte
- POST /api/systemagent/run                             — Systemagent-Kreis laufen lassen
- GET  /api/dreaming                                    — Dreaming-Übersicht
- POST /api/dreaming/nap                                — einen Nap fahren
- POST /api/dreaming/candidates/{candidate_id}/decision — Kandidaten-Entscheidung setzen
- GET  /api/engines/stats                               — aggregierte LLM-Call-Stats je Feature
- GET  /api/limits                                      — Live-Snapshot des Limits-Tabs
- GET  /api/history                                     — Message-History je Conversation
- GET  /api/message-queue/counts                        — Pending-Queue-Counts pro Conversation
- POST /api/mark-read                                   — Conversation als gelesen markieren
- POST /api/emoji-polish                                — einen Satz mit genau einem Emoji versehen

Server-Globals werden per Late-Import in den Funktionen geholt, um Zirkularität
zu vermeiden (server.py importiert dieses Modul beim include_router):
- AGENTS: Agenten-Registry, geteilte server-Global.

_get_groq_key wandert mit (nur von /api/emoji-polish und extern von
stream_helpers genutzt; server.py hält per Re-Import `server._get_groq_key` am
Leben). Der Aufruf von _groq_chat in /api/emoji-polish bleibt EXAKT erhalten
(vorbestehender, bewusst nicht reparierter Bestand).

asyncio/subprocess/os kommen direkt aus dem Standardbibliotheks-Import.
public_identity_payload kommt direkt aus identity (sauberer Modul-Import).
"""

import os
import asyncio
import subprocess

from fastapi import APIRouter, Request, Body
from fastapi.responses import JSONResponse

from identity import public_identity_payload
from db import get_db, get_msgs
from engines import engine_profiles, runtime_engine_ids

router = APIRouter()


# ── UI-Command ──

@router.post("/api/ui-command")
async def ui_command(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "invalid json"}, status_code=400)

    command = str(body.get("command") or "").strip()
    payload = body.get("payload") or {}
    if not isinstance(payload, dict):
        return JSONResponse({"ok": False, "error": "payload must be object"}, status_code=400)

    allowed_commands = {"info", "pane", "info-section"}
    if command not in allowed_commands:
        return JSONResponse(
            {"ok": False, "error": f"command must be one of {sorted(allowed_commands)}"},
            status_code=400,
        )

    if command == "info":
        action = str(payload.get("action") or "toggle").lower()
        if action not in {"open", "close", "toggle"}:
            return JSONResponse({"ok": False, "error": "info.action must be open|close|toggle"}, status_code=400)
        payload = {"action": action}
    elif command == "pane":
        action = str(payload.get("action") or "").lower()
        if action not in {"add", "close-last", "close-index", "only-active"}:
            return JSONResponse(
                {"ok": False, "error": "pane.action must be add|close-last|close-index|only-active"},
                status_code=400,
            )
        clean: dict = {"action": action}
        if action == "close-index":
            try:
                idx = int(payload.get("index"))
            except (TypeError, ValueError):
                return JSONResponse({"ok": False, "error": "pane.index required for close-index"}, status_code=400)
            if idx < 1 or idx > 4:
                return JSONResponse({"ok": False, "error": "pane.index must be 1..4"}, status_code=400)
            clean["index"] = idx
        payload = clean
    else:  # info-section
        section = str(payload.get("section") or "").strip().lower().replace("_", "-").replace(" ", "-")
        allowed_sections = {"workspace", "identity", "systemagent", "dreaming", "calendar", "jobs", "whatsapp", "mail", "artifacts", "social", "daily-log", "settings"}
        if section not in allowed_sections:
            return JSONResponse(
                {"ok": False, "error": f"section must be one of {sorted(allowed_sections)}"},
                status_code=400,
            )
        payload = {"section": section}

    from streaming import broadcast_ui_command
    delivered = await broadcast_ui_command(command, payload)
    return JSONResponse({"ok": True, "delivered": delivered, "command": command, "payload": payload})


# ── Agents / Identity / Models ──

@router.get("/api/agents")
async def get_agents():
    """Ein Agent. Engine (codex|claude) wird pro Conversation gewaehlt.

    Liefert zusaetzlich den Inhaber-Namen (owner) mit, damit das Frontend
    Begruessungen mit dem im Setup vergebenen Namen rendern kann, statt einen
    fest verdrahteten Namen zu zeigen.
    """
    from server import AGENTS
    a = AGENTS["main"]
    try:
        from backend.identity import get_owner
    except ImportError:
        from identity import get_owner
    owner = get_owner()
    return JSONResponse({
        "main": {"name": a["name"], "color": a["color"], "model": a.get("model", "")},
        "owner": {"name": owner.get("name", ""), "first_name": owner.get("first_name", "")},
    })


@router.get("/api/identity")
async def get_identity():
    """Aktive Agent-Profile und ihre Identity-Quellen."""
    return JSONResponse(public_identity_payload())


@router.get("/api/models")
async def get_models():
    """Return available models per backend."""
    return JSONResponse({"models": [
        {"id": "claude-opus-4-8", "name": "Opus 4.8", "provider": "anthropic", "contextWindow": 1000000, "reasoning": True},
        {"id": "claude-fable-5", "name": "Fable 5", "provider": "anthropic", "contextWindow": 1000000, "reasoning": True},
        {"id": "claude-opus-4-7", "name": "Opus 4.7", "provider": "anthropic", "contextWindow": 200000, "reasoning": True},
        {"id": "claude-sonnet-4-6", "name": "Sonnet 4.6", "provider": "anthropic", "contextWindow": 200000, "reasoning": True},
        {"id": "gpt-5.5", "name": "GPT-5.5", "provider": "openai", "contextWindow": 400000, "reasoning": True},
    ]})


# ── Workflows-Feedback ──

@router.post("/api/workflows/{run_id}/feedback")
async def workflow_feedback(run_id: str, payload: dict = Body(default_factory=dict)):
    """Speichert kurzes User-Feedback zu einer Learning-Log-Akte."""
    try:
        import workflows
        result = workflows.record_feedback(
            run_id,
            str(payload.get("rating") or ""),
            str(payload.get("note") or ""),
        )
        if result.get("status") != "ok":
            return JSONResponse(result, status_code=400)
        return JSONResponse(result)
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


# ── Systemagent ──

@router.post("/api/systemagent/run")
async def systemagent_run(payload: dict = Body(default_factory=dict)):
    """Lässt den Systemagent-Kreis laufen: Logbuch schreiben, bei Ereignissen pingen."""
    try:
        import systemagent
        result = systemagent.run(
            dry_run=bool(payload.get("dryRun") or payload.get("dry_run")),
            force=bool(payload.get("force")),
        )
        if result.get("posted"):
            try:
                from modules.klaus_channel.core import KLAUS_CHANNEL_AGENT, KLAUS_CHANNEL_ID
                from streaming import broadcast_sync
                await broadcast_sync(KLAUS_CHANNEL_AGENT, KLAUS_CHANNEL_ID)
            except Exception as e:
                print(f"[systemagent] broadcast failed: {e}", flush=True)
        return JSONResponse(result)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ── Dreaming ──

@router.get("/api/dreaming")
async def dreaming_overview():
    try:
        import dreaming_module
        return JSONResponse(dreaming_module.overview())
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.post("/api/dreaming/nap")
async def dreaming_nap(payload: dict = Body(default_factory=dict)):
    try:
        import dreaming_module
        result = await asyncio.to_thread(dreaming_module.run_nap, model=str(payload.get("model") or "sonnet"))
        return JSONResponse(result, status_code=200 if result.get("ok") else 500)
    except subprocess.TimeoutExpired:
        return JSONResponse({"ok": False, "status": "error", "error": "Nap timed out"}, status_code=504)
    except Exception as e:
        return JSONResponse({"ok": False, "status": "error", "error": str(e)}, status_code=500)


@router.post("/api/dreaming/candidates/{candidate_id}/decision")
async def dreaming_candidate_decision(candidate_id: str, payload: dict = Body(default_factory=dict)):
    try:
        import dreaming_module
        return JSONResponse(dreaming_module.set_decision(candidate_id, str(payload.get("status") or "open")))
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ── Engines-Stats / Limits ──

@router.get("/api/engines")
async def engines_registry():
    """Known engine profiles from setup config, with runtime support marked explicitly."""
    profiles = engine_profiles()
    return JSONResponse({
        "runtime": list(runtime_engine_ids()),
        "profiles": [
            {
                "id": profile.id,
                "label": profile.label,
                "kind": profile.kind,
                "provider": profile.provider,
                "runtime": profile.runtime,
                "default_model": profile.default_model,
                "models": sorted(profile.models),
                "setup_group": profile.setup.get("setup_group", ""),
                "auth_modes": profile.setup.get("auth_modes", []),
            }
            for profile in profiles.values()
        ],
    })


@router.get("/api/engines/stats")
async def engines_stats(seconds: int = 86400):
    """Aggregierte LLM-Call-Stats pro feature über das angegebene Zeitfenster (Default 24h).
    Quelle für den Engines-Tab im InfoPane."""
    try:
        from llm_log import stats_since
        by_feature = stats_since(seconds=max(60, min(seconds, 7 * 86400)))
    except Exception:
        by_feature = {}
    return JSONResponse({"window_seconds": seconds, "by_feature": by_feature})


@router.get("/api/limits")
async def llm_limits():
    """Live-Snapshot des Limits-Tabs: Calls, Tokens, Cost-USD je Provider
    für den aktuellen Kalendermonat, plus Restbudget gegen den $200
    Agent-SDK-Credit, der ab 2026-06-15 Anthropic-Calls über `claude -p`
    in einen separaten Topf zieht."""
    try:
        from llm_log import limits_snapshot
        snap = limits_snapshot()
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    # ElevenLabs-Kontingent live anhängen (TTS-Zeichen statt LLM-Token),
    # analog zu den Anthropic/OpenAI-Blöcken. Fehler hier brechen den
    # Snapshot nicht, der ElevenLabs-Block kommt dann als {"ok": False}.
    try:
        from voice_sync import elevenlabs_usage
        snap["elevenlabs"] = await elevenlabs_usage()
    except Exception as e:
        snap["elevenlabs"] = {"ok": False, "error": str(e)}
    return JSONResponse(snap)


# ── History / Message-Queue ──

@router.get("/api/history")
async def history(agent: str = '', project: str = '', limit: int = 100, conversation_id: str = ''):
    return JSONResponse({"messages": get_msgs(agent, project, limit, conversation_id)})


@router.get("/api/message-queue/counts")
async def message_queue_counts():
    """Pending-Queue-Counts pro Conversation — die Remote zeigt sie als Badge."""
    with get_db() as db:
        rows = db.execute(
            "SELECT conv_id, COUNT(*) FROM message_queue WHERE status = 'pending' GROUP BY conv_id"
        ).fetchall()
    return JSONResponse({"counts": {r[0]: r[1] for r in rows}})


# ── Unread Tracking ──

@router.post("/api/mark-read")
async def mark_read_endpoint(request: Request):
    body = await request.json()
    conv_id = body.get("conversationId", "")
    if not conv_id:
        return JSONResponse({"error": "conversationId required"}, status_code=400)
    from db import mark_read
    mark_read(conv_id)
    return JSONResponse({"ok": True})


# ── STT (Groq Whisper) ──

def _get_groq_key() -> str:
    return os.environ.get("GROQ_API_KEY", "")


@router.post("/api/emoji-polish")
async def emoji_polish(body: dict):
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"text": ""})
    system = (
        "Du bekommst einen kurzen Satz oder Absatz. Setze GENAU EIN passendes Emoji "
        "an einer natürlichen Stelle im Text ein (mittendrin oder am Satzende, nie ganz vorne). "
        "Ändere sonst NICHTS am Wortlaut, an Zeichensetzung oder Reihenfolge. "
        "Antworte nur mit dem fertigen Text, ohne Anführungszeichen, ohne Kommentar."
    )
    out = await _groq_chat("llama-3.3-70b-versatile", system, text, max_tokens=300)
    return JSONResponse({"text": out or text})
