"""``python -m taigi_sidecar`` 入口：port 0 由系統分配，就緒後輸出一行
``TAIGI_SIDECAR_READY {"port": N}`` 供 Rust 外殼解析。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import uvicorn

from .app import create_app


async def _serve(base: Path, token: str) -> None:
    app = create_app(base=base, expected_token=token)
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=0,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())

    while not server.started:
        await asyncio.sleep(0.02)
    # 就緒後 socket 已 bound，從實際監聽位址拿到系統埠。
    sockets = [s for s in server.servers[0].sockets if s.family.name in ("AF_INET", "AF_INET6")]
    port = sockets[0].getsockname()[1]
    print("TAIGI_SIDECAR_READY " + json.dumps({"port": port}), flush=True)

    await task


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True, type=Path)
    parser.add_argument(
        "--token",
        default=os.environ.get("TAIGI_SIDECAR_TOKEN", ""),
        help="鑑權 token，預設讀 TAIGI_SIDECAR_TOKEN",
    )
    args = parser.parse_args()
    if not args.token:
        print("缺少 TAIGI_SIDECAR_TOKEN", file=sys.stderr)
        sys.exit(1)
    asyncio.run(_serve(args.base, args.token))


if __name__ == "__main__":
    main()
