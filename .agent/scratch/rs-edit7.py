import pathlib

p = pathlib.Path("app/cli.py")
s = p.read_bytes().decode()
s = s.replace('''def _cmd_model_fetch''', '''def _cmd_index_verify(args: argparse.Namespace, settings: Settings) -> int:
    from app.index.verify import verify

    report = verify(settings, [Path(p) for p in args.catalog_db])
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["ok"] else 1


def _cmd_model_fetch''', 1)
s = s.replace('''    index.add_parser("status").set_defaults(func=_cmd_index_status)
''', '''    index.add_parser("status").set_defaults(func=_cmd_index_status)
    verify_p = index.add_parser("verify", help="check every indexed card id exists in the catalog DB(s)")
    verify_p.add_argument("--catalog-db", action="append", required=True, metavar="PATH",
                          help="catalog-<lang>-<version>.db (repeat for each language)")
    verify_p.set_defaults(func=_cmd_index_verify)
''', 1)
p.write_bytes(s.encode())
