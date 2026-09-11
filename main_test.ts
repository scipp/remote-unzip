import { assert, assertEquals } from "@std/assert";
import {
  configure,
  terminateWorkers,
  TextReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "zipjs";
import { handleRequest } from "./main.ts";

configure({ useWebWorkers: false });

const origin = "https://remote-unzip.example";
const api = "https://api.github.com/repos/scipp/ess";
const asset = { id: 12345678901, name: "documentation-1.2.3.zip" };

function request(path: string) {
  return handleRequest(new Request(new URL(path, origin)));
}

async function withFetch(
  respond: (req: Request) => Response | Promise<Response>,
  check: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = (input, init) => {
    const req = new Request(input, init);
    calls.push(req);
    return Promise.resolve(respond(req));
  };
  try {
    await check(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function assertRedirect(response: Response, path: string) {
  assertEquals(response.status, 302);
  assertEquals(response.headers.get("location"), origin + path);
}

async function assertFailedBody(response: Response) {
  const reader = response.body!.getReader();
  let timer: ReturnType<typeof setTimeout>;
  try {
    const outcome = await Promise.race([
      (async () => {
        try {
          while (!(await reader.read()).done) { /* Drain the response. */ }
          return "closed";
        } catch {
          return "failed";
        }
      })(),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("timed out"), 1000);
      }),
    ]);
    assertEquals(outcome, "failed");
  } finally {
    clearTimeout(timer!);
    await reader.cancel().catch(() => {});
  }
}

function existingTag(req: Request) {
  const prefix = "/git/ref/tags/";
  const path = new URL(req.url).pathname;
  if (path.includes(prefix)) {
    return Response.json({
      ref: `refs/tags/${decodeURIComponent(path.split(prefix)[1])}`,
      object: { type: "tag", sha: "tag-sha" },
    });
  }
}

function existingBranch(req: Request) {
  const path = new URL(req.url).pathname;
  if (path.includes("/git/ref/tags/")) {
    return new Response(null, { status: 404 });
  }
  const prefix = "/git/ref/heads/";
  if (path.includes(prefix)) {
    return Response.json({
      ref: `refs/heads/${decodeURIComponent(path.split(prefix)[1])}`,
      object: { type: "commit", sha: "branch-sha" },
    });
  }
}

async function makeZip(files: Record<string, string>, level = 0) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { level });
  for (const [name, contents] of Object.entries(files)) {
    await writer.add(name, new TextReader(contents));
  }
  return new Uint8Array(await writer.close());
}

function zipResponse(req: Request, zip: Uint8Array<ArrayBuffer>) {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Length": String(zip.length),
  });
  if (req.method === "HEAD") return new Response(null, { headers });
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (!range) return new Response(zip, { headers });
  const start = range[1] ? Number(range[1]) : zip.length - Number(range[2]);
  const end = range[1] && range[2] ? Number(range[2]) : zip.length - 1;
  const data = zip.slice(start, end + 1);
  headers.set("Content-Length", String(data.length));
  headers.set("Content-Range", `bytes ${start}-${end}/${zip.length}`);
  return new Response(data, { status: 206, headers });
}

Deno.test("archive IDs are complete path segments and redirects preserve queries", async (t) => {
  for (
    const route of [
      "artifacts",
      "actions/artifacts",
      "actions/runs/12345678901/artifacts",
      "assets",
      "releases/assets",
    ]
  ) {
    for (
      const id of ["123456789", "1234567890", "10068025495", "100680254950"]
    ) {
      await t.step(`${route}/${id}`, () =>
        withFetch(
          () => {
            throw new Error("A directory redirect must not fetch an archive");
          },
          async (calls) => {
            const path = `/scipp/ess/${route}/${id}`;
            assertRedirect(
              await request(path + "?download=1"),
              path + "/?download=1",
            );
            assertEquals(calls.length, 0);
          },
        ));
    }
  }
});

Deno.test("release tags preserve their full name and requested file", async (t) => {
  for (
    const [encodedRef, tag] of [
      ["release%2F1.2.3", "release/1.2.3"],
      ["release%2f1.2.3", "release/1.2.3"],
      ["releases%2Fteam%2Fnightly", "releases/team/nightly"],
      ["v%2Frelease%2F1.2.3", "v/release/1.2.3"],
      ["release%2Fa%26b%252F", "release/a&b%2F"],
      ["1.2.3", "1.2.3"],
      ["v1.2.3", "v1.2.3"],
      ["nightly", "nightly"],
      ["main", "main"],
      ["v1.2.3-rc.1", "v1.2.3-rc.1"],
      ["1.2.3%2Bbuild", "1.2.3+build"],
    ]
  ) {
    await t.step(encodedRef, () =>
      withFetch(
        (req) => existingTag(req) ?? Response.json({ assets: [asset] }),
        async (calls) => {
          assertRedirect(
            await request(`/scipp/ess/${encodedRef}/docs/my%20page.html`),
            `/scipp/ess/assets/${asset.id}/docs/my%20page.html`,
          );
          assertEquals(calls.map((req) => req.url), [
            `${api}/git/ref/tags/${encodeURIComponent(tag)}`,
            `${api}/releases/tags/${encodeURIComponent(tag)}`,
          ]);
        },
      ));
  }
});

Deno.test("release defaults use the ZIP name and skip non-ZIP assets", () =>
  withFetch(
    (req) =>
      existingTag(req) ?? Response.json({
        assets: [
          { id: 1, name: "documentation-1.2.3.zip.asc" },
          { id: 2, name: "source.zip" },
          asset,
        ],
      }),
    async () => {
      for (const suffix of ["", "/"]) {
        assertRedirect(
          await request(`/scipp/ess/release%2F1.2.3${suffix}`),
          `/scipp/ess/assets/${asset.id}/documentation-1.2.3/index.html`,
        );
      }
    },
  ));

Deno.test("missing tags fall back to exact branches regardless of name", async (t) => {
  for (
    const ref of ["main", "nightly", "1.2.3", "v1.2.3", "feature/docs&more"]
  ) {
    await t.step(ref, () =>
      withFetch(
        (req) =>
          existingBranch(req) ?? (req.url.includes("/actions/runs?")
            ? Response.json({ workflow_runs: [{ id: 42 }] })
            : Response.json({ artifacts: [{ id: 10068025495 }] })),
        async (calls) => {
          const encodedRef = encodeURIComponent(ref);
          assertRedirect(
            await request(
              `/scipp/ess/${encodedRef}/docs/index.html?artifact_name=docs%26html`,
            ),
            "/scipp/ess/actions/artifacts/10068025495/docs/index.html",
          );
          assertEquals(calls.map((req) => req.url), [
            `${api}/git/ref/tags/${encodedRef}`,
            `${api}/git/ref/heads/${encodedRef}`,
            `${api}/actions/runs?branch=${encodedRef}&page=1&per_page=10`,
            `${api}/actions/runs/42/artifacts?name=docs%26html&per_page=1`,
          ]);
        },
      ));
  }
});

Deno.test("existing tags without releases or docs never fall back to branches", async (t) => {
  for (
    const [path, respond] of [
      ["1.2.3", () => Response.json({ message: "Not Found" }, { status: 404 })],
      ["release%2F1.2.3", () => Response.json({ assets: [] })],
    ] as const
  ) {
    await t.step(
      path,
      () =>
        withFetch((req) => existingTag(req) ?? respond(), async (calls) => {
          assertEquals((await request(`/scipp/ess/${path}/`)).status, 404);
          assertEquals(calls.map((req) => req.url), [
            `${api}/git/ref/tags/${path}`,
            `${api}/releases/tags/${path}`,
          ]);
        }),
    );
  }
});

Deno.test("a missing tag and branch return 404 before searching workflow history", () =>
  withFetch(
    () => new Response(null, { status: 404 }),
    async (calls) => {
      assertEquals(
        (await request("/scipp/ess/missing/index.html")).status,
        404,
      );
      assertEquals(calls.map((req) => req.url), [
        `${api}/git/ref/tags/missing`,
        `${api}/git/ref/heads/missing`,
      ]);
    },
  ));

Deno.test("GitHub failures return 502 without attempting other lookups", async (t) => {
  for (const ref of ["main", "release%2F1.2.3"]) {
    for (const status of [401, 403, 429, 500]) {
      await t.step(`${ref}: HTTP ${status}`, () =>
        withFetch(
          () => Response.json({ message: "upstream failure" }, { status }),
          async (calls) => {
            assertEquals((await request(`/scipp/ess/${ref}/`)).status, 502);
            assertEquals(calls.length, 1);
          },
        ));
    }
    for (
      const [name, respond] of [
        ["network error", () => {
          throw new TypeError("connection reset");
        }],
        ["invalid JSON", () => new Response("not JSON")],
      ] as const
    ) {
      await t.step(
        `${ref}: ${name}`,
        () =>
          withFetch(respond, async (calls) => {
            assertEquals((await request(`/scipp/ess/${ref}/`)).status, 502);
            assertEquals(calls.length, 1);
          }),
      );
    }
  }
});

Deno.test("release and branch lookup errors do not change the selected ref", async (t) => {
  for (const stage of ["release", "branch"]) {
    for (const status of [403, 429, 500]) {
      await t.step(`${stage}: HTTP ${status}`, () =>
        withFetch(
          (req) => {
            if (req.url.includes("/git/ref/tags/")) {
              return stage === "release"
                ? existingTag(req)!
                : new Response(null, { status: 404 });
            }
            return new Response(null, { status });
          },
          async (calls) => {
            assertEquals(
              (await request("/scipp/ess/main/index.html")).status,
              502,
            );
            assertEquals(calls.map((req) => req.url), [
              `${api}/git/ref/tags/main`,
              stage === "release"
                ? `${api}/releases/tags/main`
                : `${api}/git/ref/heads/main`,
            ]);
          },
        ));
    }
  }
});

Deno.test("branch paths containing archive route names remain branch paths", async (t) => {
  for (
    const file of [
      "docs/artifacts/10068025495/index.html",
      "docs/assets/1234567890/index.html",
      "docs/actions/runs/42/artifacts/10068025495/index.html",
    ]
  ) {
    await t.step(file, () =>
      withFetch(
        (req) =>
          existingBranch(req) ?? (
            req.url.includes("/actions/runs?")
              ? Response.json({ workflow_runs: [{ id: 42 }] })
              : Response.json({ artifacts: [{ id: 10068025495 }] })
          ),
        async (calls) => {
          assertRedirect(
            await request(`/scipp/ess/main/${file}`),
            `/scipp/ess/actions/artifacts/10068025495/${file}`,
          );
          assertEquals(calls.length, 4);
          assertEquals(
            new URL(calls[2].url).searchParams.get("branch"),
            "main",
          );
        },
      ));
  }
});

Deno.test("missing workflow API resources are upstream failures", async (t) => {
  for (const stage of ["runs", "artifacts"]) {
    await t.step(stage, () =>
      withFetch(
        (req) => {
          const ref = existingBranch(req);
          if (ref) return ref;
          if (stage === "artifacts" && req.url.includes("/actions/runs?")) {
            return Response.json({ workflow_runs: [{ id: 42 }] });
          }
          return new Response(null, { status: 404 });
        },
        async (calls) => {
          assertEquals(
            (await request("/scipp/ess/main/index.html")).status,
            502,
          );
          assertEquals(calls.length, stage === "runs" ? 3 : 4);
        },
      ));
  }
});

Deno.test("malformed ref and file encodings fail before fetching", () =>
  withFetch(
    () => {
      throw new Error("Malformed URLs must not fetch");
    },
    async (calls) => {
      for (
        const path of [
          "/scipp/ess/release%ZZ/docs",
          "/scipp/ess/artifacts/10068025495/%ZZ",
        ]
      ) {
        assertEquals((await request(path)).status, 400);
      }
      assertEquals((await request("/scipp/ess")).status, 404);
      assertEquals(calls.length, 0);
    },
  ));

Deno.test("branch artifact preference and pagination are preserved", () =>
  withFetch(
    (req) => {
      const ref = existingBranch(req);
      if (ref) return ref;
      const url = new URL(req.url);
      if (url.pathname.endsWith("/actions/runs")) {
        const page = Number(url.searchParams.get("page"));
        return Response.json({
          workflow_runs: page === 1
            ? Array.from({ length: 10 }, (_, id) => ({ id }))
            : [{ id: 10 }],
        });
      }
      return Response.json({
        artifacts: url.pathname.includes("/runs/10/") &&
            url.searchParams.get("name") === "html"
          ? [{ id: 10068025495 }]
          : [],
      });
    },
    async (calls) => {
      assertRedirect(
        await request("/scipp/scipp/main/docs/index.html"),
        "/scipp/scipp/actions/artifacts/10068025495/docs/index.html",
      );
      const runs = calls.filter((req) =>
        new URL(req.url).pathname.endsWith("/actions/runs")
      );
      assertEquals(
        runs.map((req) => new URL(req.url).searchParams.get("page")),
        ["1", "2"],
      );
      assertEquals(
        calls.slice(3, 6).map((req) =>
          new URL(req.url).searchParams.get("name")
        ),
        ["docs_html", "html", "DocumentationHTML"],
      );
    },
  ));

Deno.test("release redirects lead to files streamed from the selected ZIP", async () => {
  const zip = await makeZip({
    "documentation-1.2.3/index.html": "<h1>Documentation</h1>",
    "docs/my page.html": "A file with spaces",
  });
  await withFetch(
    (req) => {
      const ref = existingTag(req);
      if (ref) return ref;
      if (req.url === `${api}/releases/tags/release%2F1.2.3`) {
        return Response.json({ assets: [asset] });
      }
      assertEquals(req.url, `${api}/releases/assets/${asset.id}`);
      assertEquals(req.headers.get("accept"), "application/octet-stream");
      return zipResponse(req, zip);
    },
    async (calls) => {
      const redirect = await request("/scipp/ess/release%2F1.2.3/");
      const location = redirect.headers.get("location");
      assert(location);
      const response = await request(location);
      assertEquals(response.status, 200);
      assertEquals(await response.text(), "<h1>Documentation</h1>");
      assertEquals(
        response.headers.get("content-type"),
        "text/html; charset=utf-8",
      );
      assertEquals(response.headers.get("cache-control"), "max-age=31536000");
      const page = await request(
        `/scipp/ess/assets/${asset.id}/docs/my%20page.html`,
      );
      assertEquals(await page.text(), "A file with spaces");
      assertEquals(
        (await request(`/scipp/ess/assets/${asset.id}/missing.html`)).status,
        404,
      );
      assert(calls.some((req) => req.headers.has("range")));
    },
  );
});

Deno.test("artifact name lists use standard query decoding", async (t) => {
  for (
    const [query, expected] of [
      ["", ["docs_html"]],
      ["?artifact_name", ["docs_html"]],
      ["?artifact_name=", ["docs_html"]],
      ["?artifact_name=,,", ["docs_html"]],
      ["?artifact_name=custom,", ["custom"]],
      ["?artifact_name=one,two&artifact_name=three", ["one", "two", "three"]],
      ["?artifact_name=one%2Ctwo", ["one", "two"]],
      ["?artifact_name=one%2ctwo,three", ["one", "two", "three"]],
      ["?artifact_name=%20docs%20", [" docs "]],
      ["?artifact_name=docs%26html%2Bextra%3Dyes", ["docs&html+extra=yes"]],
      ["?artifact_name=docs+html", ["docs html"]],
      ["?unrelated=one,two", ["docs_html"]],
    ] as const
  ) {
    await t.step(query || "defaults", () =>
      withFetch(
        (req) =>
          existingBranch(req) ?? (req.url.includes("/actions/runs?")
            ? Response.json({ workflow_runs: [{ id: 42 }] })
            : Response.json({ artifacts: [] })),
        async (calls) => {
          assertEquals(
            (await request(`/scipp/ess/main/index.html${query}`)).status,
            404,
          );
          assertEquals(
            calls.slice(3).map((req) =>
              new URL(req.url).searchParams.get("name")
            ),
            [...expected],
          );
        },
      ));
  }
});

Deno.test("repository name casing does not change default artifact names", () =>
  withFetch(
    (req) =>
      existingBranch(req) ??
        (req.url.includes("/actions/runs?")
          ? Response.json({ workflow_runs: [{ id: 42 }] })
          : Response.json({ artifacts: [] })),
    async (calls) => {
      for (const repo of ["scipp", "Scipp", "SCIPP"]) {
        const start = calls.length;
        assertEquals(
          (await request(`/scipp/${repo}/main/index.html`)).status,
          404,
        );
        assertEquals(
          calls.slice(start + 3).map((req) =>
            new URL(req.url).searchParams.get("name")
          ),
          ["docs_html", "html", "DocumentationHTML"],
        );
      }
    },
  ));

Deno.test("standard artifact links serve files and directory indexes", async () => {
  const zip = await makeZip({
    "index.html": "Root index",
    "guide/": "",
    "guide/index.html": "Guide index",
    "guide name/index.html": "Index with spaces",
    "guide/README": "No extension",
    "guide.html/README": "No extension in a dotted directory",
    "download": "Exact file",
    "download/index.html": "Directory index",
  });
  const path = "/scipp/ess/actions/runs/42/artifacts/66000000001";
  await withFetch(
    (req) => {
      assertEquals(req.url, `${api}/actions/artifacts/66000000001/zip`);
      return zipResponse(req, zip);
    },
    async () => {
      assertEquals(await (await request(`${path}/`)).text(), "Root index");
      assertRedirect(
        await request(`${path}/guide?theme=dark`),
        `${path}/guide/?theme=dark`,
      );
      const guide = await request(`${path}/guide/`);
      assertEquals(
        guide.headers.get("content-type"),
        "text/html; charset=utf-8",
      );
      assertEquals(await guide.text(), "Guide index");
      assertEquals(
        await (await request(`${path}/guide%20name/`)).text(),
        "Index with spaces",
      );
      assertEquals(
        await (await request(`${path}/download`)).text(),
        "Exact file",
      );
      assertEquals((await request(`${path}/missing/`)).status, 404);
      for (const file of ["guide/README", "guide.html/README"]) {
        const response = await request(`${path}/${file}`);
        assertEquals(response.status, 200);
        await response.text();
        assertEquals(
          response.headers.get("content-type"),
          "application/octet-stream",
        );
      }
    },
  );
});

Deno.test("archive HTTP and network errors return 502", async (t) => {
  for (const status of [401, 403, 404, 410, 429, 500]) {
    await t.step(`HTTP ${status}`, () =>
      withFetch(
        () => new Response(null, { status }),
        async () => {
          const response = await request(
            `/scipp/ess/artifacts/${77000000000 + status}/index.html`,
          );
          assertEquals(response.status, 502);
          assertEquals(await response.text(), "Failed to read ZIP archive");
        },
      ));
  }
  await t.step("network error", () =>
    withFetch(
      () => {
        throw new TypeError("connection reset");
      },
      async () => {
        assertEquals(
          (await request("/scipp/ess/artifacts/77000000001/index.html")).status,
          502,
        );
      },
    ));
  await t.step("invalid ZIP", () =>
    withFetch(
      (req) => zipResponse(req, new TextEncoder().encode("not a ZIP")),
      async () => {
        assertEquals(
          (await request("/scipp/ess/artifacts/77000000002/index.html")).status,
          502,
        );
      },
    ));
});

Deno.test("extraction errors fail the body instead of hanging or closing successfully", async (t) => {
  const zip = await makeZip({ "index.html": "Documentation" });
  const header = new DataView(zip.buffer);
  const dataOffset = 30 + header.getUint16(26, true) +
    header.getUint16(28, true);
  for (const [index, failure] of ["local header", "file data"].entries()) {
    const bytes = new Uint8Array(zip);
    if (failure === "local header") bytes[0] = 0;
    await t.step(failure, () =>
      withFetch(
        (req) => {
          if (
            failure === "file data" &&
            req.headers.get("range")?.startsWith(`bytes=${dataOffset}-`)
          ) {
            return new Response(null, { status: 500 });
          }
          return zipResponse(req, bytes);
        },
        async () => {
          const response = await request(
            `/scipp/ess/artifacts/${78000000000 + index}/index.html`,
          );
          assertEquals(response.status, 200);
          await assertFailedBody(response);
        },
      ));
  }
});

Deno.test("compressed extraction errors fail the body with ZIP workers enabled", async () => {
  const zip = await makeZip({ "index.html": "Documentation".repeat(10000) }, 6);
  const header = new DataView(zip.buffer);
  const dataOffset = 30 + header.getUint16(26, true) +
    header.getUint16(28, true);
  configure({ useWebWorkers: true });
  try {
    await withFetch(
      (req) => {
        if (req.headers.get("range")?.startsWith(`bytes=${dataOffset}-`)) {
          return new Response(null, { status: 500 });
        }
        return zipResponse(req, zip);
      },
      async () => {
        const response = await request(
          "/scipp/ess/artifacts/79000000002/index.html",
        );
        assertEquals(response.status, 200);
        await assertFailedBody(response);
      },
    );
  } finally {
    terminateWorkers();
    configure({ useWebWorkers: false });
  }
});

Deno.test("compressed archives stream successfully with ZIP workers enabled", async () => {
  configure({ useWebWorkers: true });
  try {
    const contents = "<h1>Documentation</h1>".repeat(10000);
    const zip = await makeZip({ "index.html": contents }, 6);
    await withFetch(
      (req) => zipResponse(req, zip),
      async () => {
        const response = await request(
          "/scipp/ess/artifacts/79000000001/index.html",
        );
        assertEquals(response.status, 200);
        assertEquals(await response.text(), contents);
      },
    );
  } finally {
    terminateWorkers();
    configure({ useWebWorkers: false });
  }
});

function directoryReads(calls: Request[], zip: Uint8Array<ArrayBuffer>) {
  const footer = new DataView(zip.buffer, zip.byteOffset + zip.length - 22);
  const start = footer.getUint32(16, true);
  const end = start + footer.getUint32(12, true) - 1;
  return calls.filter((req) =>
    req.headers.get("range") === `bytes=${start}-${end}`
  );
}

Deno.test("archive entries are reused across files, aliases, redirects and misses", async () => {
  const zip = await makeZip({
    "index.html": "Home",
    "styles.css": "body { color: blue; }",
    "guide/index.html": "Guide",
  });
  const path = "/scipp/ess/artifacts/81000000001";
  await withFetch((req) => zipResponse(req, zip), async (calls) => {
    assertEquals(await (await request(`${path}/`)).text(), "Home");
    assertEquals(
      await (await request(
        "/scipp/ess/actions/runs/42/artifacts/81000000001/styles.css",
      )).text(),
      "body { color: blue; }",
    );
    assertRedirect(await request(`${path}/guide`), `${path}/guide/`);
    assertEquals(await (await request(`${path}/guide/`)).text(), "Guide");
    assertEquals((await request(`${path}/missing.html`)).status, 404);
    assertEquals(directoryReads(calls, zip).length, 1);
    assertEquals(
      calls.filter((req) => req.headers.get("range") === "bytes=0-0").length,
      1,
    );
  });
});

Deno.test("concurrent requests share entries and independently stream the same file", async (t) => {
  const files = {
    "index.html": "Documentation".repeat(10000),
    "guide.html": "Another page".repeat(20000),
  };
  const zip = await makeZip(files, 6);
  for (const useWebWorkers of [false, true]) {
    await t.step(`workers: ${useWebWorkers}`, async () => {
      configure({ useWebWorkers });
      try {
        await withFetch((req) => zipResponse(req, zip), async (calls) => {
          const path = `/scipp/ess/artifacts/${
            82000000000 + Number(useWebWorkers)
          }`;
          for (let batch = 0; batch < 2; batch++) {
            await Promise.all(Array.from({ length: 12 }, async (_, i) => {
              const name = i % 2 ? "index.html" : "guide.html";
              assertEquals(
                await (await request(`${path}/${name}`)).text(),
                files[name],
              );
            }));
          }
          assertEquals(directoryReads(calls, zip).length, 1);
          assertEquals(
            calls.filter((req) => req.headers.get("range") === "bytes=0-0")
              .length,
            1,
          );
        });
      } finally {
        terminateWorkers();
        configure({ useWebWorkers: false });
      }
    });
  }
});

Deno.test("ten archives are retained and hits protect the least recently used archive", async () => {
  const zip = await makeZip({ "index.html": "Documentation" });
  const path = (i: number) =>
    `/scipp/ess/${i % 2 ? "assets" : "artifacts"}/${83000000000 + i}/`;
  await withFetch((req) => zipResponse(req, zip), async (calls) => {
    const read = async (i: number) => {
      const start = calls.length;
      assertEquals(await (await request(path(i))).text(), "Documentation");
      return directoryReads(calls.slice(start), zip).length;
    };
    for (let i = 0; i < 10; i++) assertEquals(await read(i), 1);
    assertEquals(await read(0), 0);
    assertEquals(await read(10), 1);
    for (const i of [0, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      assertEquals(await read(i), 0);
    }
    assertEquals(await read(1), 1);
  });
});

Deno.test("eviction does not interrupt a response using an archive", async () => {
  const contents = "Documentation".repeat(100000);
  const zip = await makeZip({ "index.html": contents });
  await withFetch((req) => zipResponse(req, zip), async () => {
    const response = await request(
      "/scipp/ess/artifacts/84000000000/index.html",
    );
    for (let i = 1; i <= 10; i++) {
      assertEquals(
        (await request(`/scipp/ess/artifacts/${84000000000 + i}/missing`))
          .status,
        404,
      );
    }
    assertEquals(await response.text(), contents);
  });
});

Deno.test("a failed shared archive load can be retried", async () => {
  const zip = await makeZip({ "index.html": "Recovered" });
  let fail = true;
  await withFetch(
    (req) => fail ? new Response(null, { status: 500 }) : zipResponse(req, zip),
    async (calls) => {
      const path = "/scipp/ess/artifacts/85000000000/index.html";
      const responses = await Promise.all([request(path), request(path)]);
      assertEquals(responses.map((response) => response.status), [502, 502]);
      assertEquals(calls.length, 1);
      fail = false;
      assertEquals(await (await request(path)).text(), "Recovered");
      assertEquals(await (await request(path)).text(), "Recovered");
      assertEquals(directoryReads(calls, zip).length, 1);
    },
  );
});

Deno.test("failure of an evicted pending load preserves its replacement", async () => {
  const zip = await makeZip({ "index.html": "Documentation" });
  const blocked = Promise.withResolvers<Response>();
  const firstFetch = Promise.withResolvers<void>();
  const archiveUrl = `${api}/actions/artifacts/86000000000/zip`;
  let first = true;
  await withFetch((req) => {
    if (req.url === archiveUrl && first) {
      first = false;
      firstFetch.resolve();
      return blocked.promise;
    }
    return zipResponse(req, zip);
  }, async (calls) => {
    const path = "/scipp/ess/artifacts/86000000000/missing";
    const old = request(path);
    try {
      await firstFetch.promise;
      for (let i = 1; i <= 10; i++) {
        assertEquals(
          (await request(`/scipp/ess/artifacts/${86000000000 + i}/missing`))
            .status,
          404,
        );
      }
      assertEquals((await request(path)).status, 404);
    } finally {
      blocked.resolve(new Response(null, { status: 500 }));
    }
    assertEquals((await old).status, 502);
    const start = calls.length;
    assertEquals((await request(path)).status, 404);
    assertEquals(calls.length, start);
  });
});
