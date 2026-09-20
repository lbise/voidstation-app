import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("bounds decoded media responses and closes streams on success and rejection", () => {
  const result = execFileSync("python3", ["-B", "-c", `
import gzip
import io
import sys
sys.path.insert(0, "worker/media/upstream")
import requests
from urllib3.response import HTTPResponse
from media_restricted import MAX_RESPONSE_BYTES, read_response_body

class Response:
    def __init__(self, body, compressed):
        self.closed = False
        self.raw = HTTPResponse(
            body=io.BytesIO(gzip.compress(body) if compressed else body),
            headers={"Content-Encoding": "gzip"} if compressed else {},
            preload_content=False,
        )
    def close(self):
        self.closed = True
        self.raw.close()

for compressed in (False, True):
    for size in (210_000, 2_000_000, MAX_RESPONSE_BYTES):
        response = Response(b"x" * size, compressed)
        assert len(read_response_body(response)) == size
        assert response.closed
    response = Response(b"x" * (MAX_RESPONSE_BYTES + 1), compressed)
    try:
        read_response_body(response)
        raise AssertionError("oversized decoded body accepted")
    except requests.exceptions.RequestException:
        pass
    assert response.closed
print("bounded and closed")
`], { encoding: "utf8", timeout: 15_000 });
  expect(result.trim()).toBe("bounded and closed");
});
