import { type Entry, HttpRangeReader, ZipReader } from "zipjs";
import * as mime from "mime-types";

const token = Deno.env.get("GITHUB_TOKEN_NOPERMISSIONS");
const zipReaders = new Map<string, ZipReader<Uint8Array>>();

async function githubJson(
  url: string,
  opts: RequestInit,
  allowMissing = false,
) {
  const response = await fetch(url, opts);
  if (!response.ok) {
    await response.body?.cancel();
    if (allowMissing && response.status === 404) return null;
    throw new Error(`GitHub returned HTTP ${response.status}`);
  }
  return response.json();
}

function getArtifactNames(url: URL, repo: string): string[] {
  const names = url.searchParams.getAll("artifact_name")
    .flatMap((value) => value.split(","))
    .filter(Boolean);
  if (names.length) return names;
  return repo.toLowerCase() === "scipp"
    ? ["docs_html", "html", "DocumentationHTML"]
    : ["docs_html"];
}

async function redirectToRef(url: URL, opts: RequestInit): Promise<Response> {
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (!match) {
    return new Response(
      "Provide a valid GitHub artifact, asset, branch or tag URL",
      { status: 404 },
    );
  }

  const [, owner, repo, ref, targetFile = ""] = match;
  let encodedRef: string;
  try {
    encodedRef = encodeURIComponent(decodeURIComponent(ref));
  } catch {
    return new Response("Invalid branch or tag encoding", { status: 400 });
  }

  const api = `https://api.github.com/repos/${owner}/${repo}`;
  try {
    if (
      await githubJson(
        `${api}/git/ref/tags/${encodedRef}`,
        opts,
        true,
      )
    ) {
      const release = await githubJson(
        `${api}/releases/tags/${encodedRef}`,
        opts,
        true,
      );
      if (!release) {
        return new Response("No release was found for that tag", {
          status: 404,
        });
      }
      const { assets }: { assets: { id: number; name: string }[] } = release;
      const asset = assets.find((asset) =>
        asset.name.startsWith("documentation") && asset.name.endsWith(".zip")
      );
      if (!asset) {
        return new Response(
          "No documentation ZIP was found on that release",
          { status: 404 },
        );
      }

      // Default to the archive's base directory when no file was specified.
      const file = targetFile ||
        `${encodeURIComponent(asset.name.slice(0, -4))}/index.html`;
      return Response.redirect(
        `${url.origin}/${owner}/${repo}/assets/${asset.id}/${file}`,
      );
    }

    if (
      !await githubJson(
        `${api}/git/ref/heads/${encodedRef}`,
        opts,
        true,
      )
    ) {
      return new Response("No tag or branch was found with that name", {
        status: 404,
      });
    }

    const artifactNames = getArtifactNames(url, repo);
    const perPage = 10;
    // Search up to nine pages, stopping as soon as a matching artifact is found.
    for (let page = 1; page < 10; page++) {
      const { workflow_runs: runs } = await githubJson(
        `${api}/actions/runs?branch=${encodedRef}&page=${page}&per_page=${perPage}`,
        opts,
      );
      for (const run of runs) {
        for (const name of artifactNames) {
          const { artifacts } = await githubJson(
            `${api}/actions/runs/${run.id}/artifacts?name=${
              encodeURIComponent(name)
            }&per_page=1`,
            opts,
          );
          if (artifacts.length > 0) {
            return Response.redirect(
              `${url.origin}/${owner}/${repo}/actions/artifacts/${
                artifacts[0].id
              }/${targetFile}`,
            );
          }
        }
      }
      if (runs.length < perPage) break;
    }
    return new Response("No docs artifact was found on that branch", {
      status: 404,
    });
  } catch (error) {
    console.error("Failed to fetch documentation from GitHub", error);
    return new Response("Failed to fetch documentation from GitHub", {
      status: 502,
    });
  }
}

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const opts = { headers: new Headers() };
  if (token) opts.headers.set("Authorization", `token ${token}`);

  const artifact = url.pathname.match(
    /^\/([^/]+)\/([^/]+)\/(?:actions\/(?:runs\/\d+\/)?)?artifacts\/(\d+)(?:\/(.*))?$/,
  );
  const asset = url.pathname.match(
    /^\/([^/]+)\/([^/]+)\/(?:releases\/)?assets\/(\d+)(?:\/(.*))?$/,
  );
  const archive = artifact ?? asset;
  if (!archive) return redirectToRef(url, opts);

  const [, owner, repo, id, file = ""] = archive;
  const remoteUrl = artifact
    ? `https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${id}/zip`
    : `https://api.github.com/repos/${owner}/${repo}/releases/assets/${id}`;
  if (asset) opts.headers.set("Accept", "application/octet-stream");

  if (!file && !url.pathname.endsWith("/")) {
    url.pathname += "/";
    return Response.redirect(url.href);
  }

  let targetFile: string;
  try {
    targetFile = decodeURIComponent(file);
    if (!targetFile || targetFile.endsWith("/")) targetFile += "index.html";
  } catch {
    return new Response("Invalid file path encoding", { status: 400 });
  }

  let zipReader = zipReaders.get(remoteUrl);
  if (!zipReader) {
    zipReader = new ZipReader(new HttpRangeReader(remoteUrl, opts));
    zipReaders.set(remoteUrl, zipReader);
  }
  let entries: Entry[];
  try {
    entries = await zipReader.getEntries();
  } catch (error) {
    console.error(error);
    return new Response("Failed to read ZIP archive", { status: 502 });
  }
  const targetEntry = entries.find((entry) =>
    !entry.directory && entry.filename === targetFile
  );
  if (!targetEntry?.getData) {
    if (
      !url.pathname.endsWith("/") &&
      entries.some((entry) =>
        !entry.directory && entry.filename === `${targetFile}/index.html`
      )
    ) {
      url.pathname += "/";
      return Response.redirect(url.href);
    }
    return new Response("File not found", { status: 404 });
  }

  let controller: TransformStreamDefaultController<Uint8Array>;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  // zip.js may close its writer on failure, so only close after successful extraction.
  targetEntry.getData(stream, { preventClose: true })
    .then(() => stream.writable.close())
    .catch((error: unknown) => {
      console.error("Stream was interrupted", error);
      controller.error(error);
    });
  return new Response(stream.readable, {
    headers: {
      "Content-Type": mime.contentType(mime.lookup(targetFile)) ||
        "application/octet-stream",
      "Cache-Control": "max-age=31536000",
    },
  });
}

if (import.meta.main) Deno.serve(handleRequest);
