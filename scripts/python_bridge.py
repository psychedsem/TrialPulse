"""Local read-only JSON transport for the existing Python services."""

import argparse
from contextlib import redirect_stdout
import json
from pathlib import Path
import sys


PROTOCOL = 1
ROOT = Path(__file__).resolve().parent.parent
MAX_INPUT_BYTES = 131072


def _load_handler(mode):
    # Service modules use absolute imports relative to their own directories.
    service_dir = ROOT / ("data_agent" if mode == "analyze" else "rag")
    sys.path.insert(0, str(service_dir))
    with redirect_stdout(sys.stderr):
        if mode == "analyze":
            from app import AnalyzeRequest as Request, analyze as execute
        else:
            from app import RetrieveRequest as Request, retrieve_documents as execute

    def handler(payload):
        return execute(Request.model_validate(payload))
    return handler


def _response(frame, mode, handler):
    from fastapi.encoders import jsonable_encoder
    from fastapi import HTTPException
    from pydantic import ValidationError

    request_id = frame.get("id") if type(frame) is dict else None

    def failure(kind, status, code):
        return {"v": PROTOCOL, "id": request_id, "ok": False,
                "error": {"kind": kind, "status": status, "code": code}}

    if (type(frame) is not dict or frame.get("v") != PROTOCOL or
            type(request_id) is not int or request_id < 1 or
            frame.get("op") != mode or type(frame.get("body")) is not dict or
            set(frame) != {"v", "id", "op", "body"}):
        return failure("invalid_request", 422, "invalid_frame")
    try:
        # Libraries are not permitted to write diagnostics to protocol stdout.
        with redirect_stdout(sys.stderr):
            result = handler(frame["body"])
            encoded = jsonable_encoder(result)
        return {"v": PROTOCOL, "id": request_id, "ok": True, "result": encoded}
    except ValidationError:
        return failure("http", 422, "invalid_request")
    except HTTPException as exc:
        return failure("http", exc.status_code if exc.status_code in (400, 422, 503) else 503, "service_error")
    except ValueError:
        return failure("http", 400, "invalid_request")
    except Exception:
        return failure("internal", 503, "service_error")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("analyze", "retrieve"), required=True)
    parser.add_argument("--worker", action="store_true")
    args = parser.parse_args()
    if args.mode == "retrieve" and not args.worker:
        parser.error("retrieve requires --worker")
    if args.mode == "analyze" and args.worker:
        parser.error("analyze requires one-shot mode")
    try:
        handler = _load_handler(args.mode)
    except Exception:
        # Do not write a broken or partial frame after initialization failure.
        return 1
    for line in sys.stdin.buffer:
        if len(line) > MAX_INPUT_BYTES or not line.endswith(b"\n"):
            return 2
        try:
            frame = json.loads(line)
            result = _response(frame, args.mode, handler)
            sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False,
                                        separators=(",", ":")) + "\n")
            sys.stdout.flush()
        except Exception:
            return 3
        if not args.worker:
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
