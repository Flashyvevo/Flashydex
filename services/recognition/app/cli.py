"""Command line: ``python -m app.cli index build|status``, ``identify <file>``, ``serve``, ``model fetch``."""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

from app.core.config import Settings


def _setup_logging(level: str) -> None:
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                        stream=sys.stderr)
    logging.getLogger("httpx").setLevel(logging.WARNING)


def _cmd_index_build(args: argparse.Namespace, settings: Settings) -> int:
    from app.core.sysinfo import peak_rss_mb
    from app.index.build import build

    langs = [lang.strip() for lang in args.lang.split(",") if lang.strip()]
    started = time.monotonic()
    shard = tuple(int(x) for x in args.shard.split("/")) if args.shard else None
    results = build(settings, langs, limit=args.limit, shard=shard,  # type: ignore[arg-type]
                    progress=lambda p: print(json.dumps(p), flush=True))
    for lang, manifest in results.items():
        if not manifest:
            continue
        print(f"[{lang}] indexed={manifest['counts']['cards']} version={manifest['indexVersion']}")
    print(f"total {time.monotonic() - started:.1f}s peakRss={peak_rss_mb():.0f}MB")
    return 0


def _cmd_index_status(_: argparse.Namespace, settings: Settings) -> int:
    for lang in settings.langs:
        path = settings.index_dir / lang / "index-manifest.json"
        print(f"[{lang}]", path.read_text("utf-8") if path.is_file() else "no index")
    return 0


def _cmd_model_fetch(_: argparse.Namespace, settings: Settings) -> int:
    from app.index.build import ensure_model

    print(ensure_model(settings))
    return 0


def _cmd_identify(args: argparse.Namespace, settings: Settings) -> int:
    from app.recognize.pipeline import Recognizer

    recognizer = Recognizer.from_settings(settings)
    data = Path(args.file).read_bytes()
    result = recognizer.identify_bytes(data, lang=args.lang, max_candidates=args.max_candidates)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


def _cmd_serve(_: argparse.Namespace, settings: Settings) -> int:
    import uvicorn

    from app.api.app import create_app

    if not settings.token and not settings.is_loopback:
        print("refusing to bind a non-loopback host without FLASHYDEX_RECOG_TOKEN", file=sys.stderr)
        return 2
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port,
                log_level=settings.log_level.lower(), proxy_headers=False, access_log=False)
    return 0


def _cmd_eval(args: argparse.Namespace, settings: Settings) -> int:
    from app.eval import run

    print(json.dumps(run(settings, args.lang, args.n), indent=1, default=str))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="flashydex-recognition")
    sub = parser.add_subparsers(dest="cmd", required=True)

    index = sub.add_parser("index").add_subparsers(dest="index_cmd", required=True)
    build = index.add_parser("build", help="download reference images, embed, write the index")
    build.add_argument("--lang", default="en,ja")
    build.add_argument("--limit", type=int, default=None,
                       help="first N cards per language; writes data/index-sample/, not data/index/")
    build.add_argument("--shard", default=None, metavar="K/N",
                       help="cache-only worker K of N (run N processes, then a final unsharded run assembles)")
    build.set_defaults(func=_cmd_index_build)
    index.add_parser("status").set_defaults(func=_cmd_index_status)

    sub.add_parser("model").add_subparsers(dest="model_cmd", required=True).add_parser(
        "fetch").set_defaults(func=_cmd_model_fetch)

    ident = sub.add_parser("identify")
    ident.add_argument("file")
    ident.add_argument("--lang", default="any", choices=["en", "ja", "any"])
    ident.add_argument("--max-candidates", type=int, default=3)
    ident.set_defaults(func=_cmd_identify)

    sub.add_parser("serve").set_defaults(func=_cmd_serve)

    ev = sub.add_parser("eval", help="synthetic-photo eval over the real index")
    ev.add_argument("--lang", default="en")
    ev.add_argument("--n", type=int, default=200)
    ev.set_defaults(func=_cmd_eval)

    args = parser.parse_args(argv)
    settings = Settings.from_env()
    _setup_logging(settings.log_level)
    return int(args.func(args, settings))


if __name__ == "__main__":
    raise SystemExit(main())
