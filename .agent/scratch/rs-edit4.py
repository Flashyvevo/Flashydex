import pathlib

root = pathlib.Path("app")
e = root / "eval.py"
part = pathlib.Path("../../.agent/scratch/rs-eval-part.py").read_text(encoding="utf-8")
e.write_bytes(e.read_bytes() + part.replace("\r\n", "\n").encode())

p = root / "cli.py"
s = p.read_bytes().decode()
s = s.replace("""def main(argv""", """def _cmd_eval_m2(args: argparse.Namespace, settings: Settings) -> int:
    from app.eval import TRANSFORMS, run_m2

    transforms = tuple(args.transforms.split(",")) if args.transforms else TRANSFORMS
    summary = run_m2(settings, args.en, args.ja, args.out, seed=args.seed, transforms=transforms)
    print(json.dumps(summary["perTransform"], indent=1))
    return 0


def main(argv""", 1)
s = s.replace("""    args = parser.parse_args(argv)""", """    m2 = sub.add_parser("eval-m2", help="M2 transform eval (reference/rot/skew/blur/glare/jpeg/1600px photo)")
    m2.add_argument("--en", type=int, default=300)
    m2.add_argument("--ja", type=int, default=100)
    m2.add_argument("--seed", type=int, default=11)
    m2.add_argument("--transforms", default="")
    m2.add_argument("--out", default="data/logs/eval-m2.json")
    m2.set_defaults(func=_cmd_eval_m2)

    args = parser.parse_args(argv)""", 1)
p.write_bytes(s.encode())
