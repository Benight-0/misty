"""JSON-line SSH client for Misty's private desktop socket."""
import json
import socket
import sys

import config


def call(request):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(60)
        client.connect(config.data("overlay.sock"))
        client.sendall((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
        with client.makefile("r", encoding="utf-8") as reader:
            line = reader.readline(1000000)
        if not line:
            raise RuntimeError("Misty overlay connection closed")
        return json.loads(line)


def main():
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            result = call(request)
        except Exception as error:
            result = {"error": str(error)[:300]}
        print(json.dumps({"id": request.get("id") if isinstance(request, dict) else None,
                          **result}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
