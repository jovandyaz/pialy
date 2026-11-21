import argparse
from pathlib import Path

from fake_pey.server import serve

DEFAULT_PORT = 4010


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m fake_pey", description="Fake pey CoDi API for the contract suite.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--secret-file", type=Path, required=True, help="file holding the whsec_ webhook secret")
    parser.add_argument("--webhook-url", help="default target for signed webhooks; a control body may override it")
    args = parser.parse_args()
    serve(args.host, args.port, args.secret_file, args.webhook_url)


if __name__ == "__main__":
    main()
