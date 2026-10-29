"""Exercise HTTP body and Stratum line limits on a disposable loopback node."""

import http.client
import json
import socket
import time
import urllib.request


PAYMENT_LIMIT = 8 * 1024
BLOCK_LIMIT = 128 * 1024
STRATUM_LIMIT = 8 * 1024


def post(port, path, body_parts, declared_length=None):
    if declared_length is None:
        declared_length = sum(map(len, body_parts))
    with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
        connection.settimeout(5)
        connection.sendall((f"POST {path} HTTP/1.1\r\nHost: localhost\r\n"
                            f"Content-Length: {declared_length}\r\n\r\n").encode())
        for part in body_parts:
            connection.sendall(part)
            time.sleep(0.02)
        response = http.client.HTTPResponse(connection)
        response.begin()
        result = response.status, response.getheader("Connection"), json.loads(response.read())
        response.close()
        return result


def check_http(port, path, limit):
    status, _, result = post(port, path, [b" " * limit])
    assert status == 200 and result["code"] != 0, (path, status, result)

    status, close, result = post(port, path, [b" " * (limit - 1), b"  "])
    assert status == 413 and close == "close" and result["code"] != 0, (path, status, close, result)

    # The server must reject before the declared body is complete.
    status, close, result = post(port, path, [b" " * (limit + 1)], 200 * 1024 * 1024)
    assert status == 413 and close == "close" and result["code"] != 0, (path, status, close, result)


def stratum_socket():
    connection = socket.create_connection(("127.0.0.1", 3456), timeout=5)
    connection.settimeout(5)
    return connection


def subscribe(connection, request_id):
    request = json.dumps({"id": request_id, "method": "mining.subscribe", "params": []}).encode()
    connection.sendall(request + b"\n")
    data = b""
    while b"\n" not in data:
        chunk = connection.recv(4096)
        assert chunk, "Stratum disconnected before subscription reply"
        data += chunk
    reply = json.loads(data.split(b"\n", 1)[0])
    assert reply["id"] == request_id and reply["error"] is None, reply


def closed_after(parts):
    with stratum_socket() as connection:
        for part in parts:
            connection.sendall(part)
            time.sleep(0.02)
        received = b""
        while True:
            try:
                chunk = connection.recv(4096)
            except ConnectionResetError:
                break
            if not chunk:
                break
            received += chunk
            assert len(received) < 4096, "Oversized Stratum line kept producing replies"


def main():
    with urllib.request.urlopen("http://127.0.0.1:3000/chain/head", timeout=5) as response:
        assert json.load(response)["data"]["height"] == 0, "Requires isolated genesis node"

    check_http(3001, "/transaction/add", PAYMENT_LIMIT)
    check_http(3000, "/chain/append", BLOCK_LIMIT)

    with urllib.request.urlopen("http://127.0.0.1:3000/tools/wallet/new", timeout=5) as response:
        address = json.load(response)["data"]["address"]
    payment = json.dumps({"pinHeight": 0, "nonceId": 7, "feeE8": 2,
                          "amountE8": 10, "toAddr": address,
                          "signature65": "00" * 65}).encode()
    status, _, _ = post(3001, "/transaction/add", [payment])
    assert status == 200, "Normal payment request was rejected by the transport"

    # The largest consensus-allowed block body fits in the HTTP JSON envelope.
    block = json.dumps({"height": 1, "header": "00" * 80, "body": "00" * 35000}).encode()
    status, _, _ = post(3000, "/chain/append", [block])
    assert status == 200, "Maximum-size block body was rejected by the transport"

    request = json.dumps({"id": 1, "method": "mining.subscribe", "params": []}).encode()
    with stratum_socket() as connection:
        connection.sendall(request.ljust(STRATUM_LIMIT, b" ") + b"\n")
        data = b""
        while b"\n" not in data:
            chunk = connection.recv(4096)
            assert chunk, "Limit-sized Stratum line disconnected"
            data += chunk
        reply = json.loads(data.split(b"\n", 1)[0])
        assert reply["id"] == 1 and reply["error"] is None, reply
        subscribe(connection, 2)

    closed_after([b"x" * (STRATUM_LIMIT + 1) + b"\n"])
    closed_after([b"x" * 4096, b"x" * (STRATUM_LIMIT - 4096 + 1)])
    closed_after([request + b"\n" + b"x" * (STRATUM_LIMIT + 1) + b"\n" + request + b"\n"])

    with stratum_socket() as connection:
        subscribe(connection, 3)
    with urllib.request.urlopen("http://127.0.0.1:3000/chain/head", timeout=5) as response:
        assert json.load(response)["data"]["height"] == 0, "Node stopped responding"
    print("INPUT_BOUNDS_REGRESSIONS HTTP and Stratum limits passed", flush=True)


if __name__ == "__main__":
    main()
