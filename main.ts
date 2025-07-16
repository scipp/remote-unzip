import { ZipReader, HttpRangeReader, TextWriter } from "https://deno.land/x/zipjs@v2.7.24/index.js";
import * as mime from "npm:mime-types";

const token = Deno.env.get("GITHUB_TOKEN_NOPERMISSIONS");
console.log("Found token:", !!token)

const zipReaderMap = new Map();

const latest_docs_cache = new Map();
const clear_cache = setInterval(
    () => latest_docs_cache.clear(),
    60 * 1000,
);

Deno.serve(async (req) => {
  const url = new URL(req.url);

  const opts = {
    headers: {
      Authorization: `token ${token}`,
    },
  };

  let remote_url, target_file = '', cache_control = "max-age=31536000";

  // Look for url like org/repo/artifacts/xxxxx/file
  const groups = url.pathname.match(/\/([^\/]*)\/([^\/]*)\/.*artifacts\/(\d{10})\/?(.*)/);
  if (groups !== null) {
      const owner = groups[1];
      const repo = groups[2];
      const artifact = groups[3];
      console.log({owner, repo, artifact});
      target_file = groups[4];
      remote_url = `https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${artifact}/zip`
  }
  // If not found, look for url like org/repo/branch/file
  // If it matches, find the latest action run in the repo on the branch and use its first artifact
  if (remote_url === undefined) {
      const groups = url.pathname.match(/\/([^\/]*)\/([^\/]*)\/([^\/]*)\/?(.*)/);
      if (groups !== null) {
          const owner = groups[1];
          const repo = groups[2];
          const branch = groups[3];
          console.log({owner, repo, branch});
          target_file = groups[4];
          const key = [owner, repo, branch].join('/');
          for (let ntry=0; ntry < 3; ntry++) {
              try {
                  if (!latest_docs_cache.has(key)) {
                      console.log("Querying github for latest docs build");
                      const latest_artifact_url = (await (await fetch(
                          `https://api.github.com/repos/${owner}/${repo}/actions/runs?branch=${branch}&per_page=1`,
                          opts,
                      )).json()).workflow_runs[0].artifacts_url;
                      latest_docs_cache.set(
                          key,
                          (await (await fetch(
                              latest_artifact_url,
                              opts,
                          )).json()).artifacts[0].archive_download_url
                      );
                      console.log('Cache state after update:', latest_docs_cache);
                  }
              } catch (e) {
                  console.log("Error when fetching latest artifact from branch ", e);
                  continue
              }
              remote_url = latest_docs_cache.get(key);
              cache_control = "max-age=300"
              break;
          }
      }
  }
  if (remote_url === undefined) {
      return new Response(
          "No artifact path provided. Provide a valid github artifact url.", { status: 404 }
      );
  }
  if (target_file == '') {
      target_file = 'index.html';

      if (req.url.slice(-1) !== '/') {
          return Response.redirect(req.url + '/');
      }
  }
  console.log(remote_url, target_file);
  
  if (!zipReaderMap.has(remote_url)) {
      const httpReader = new HttpRangeReader(remote_url, opts);
      zipReaderMap.set(remote_url, new ZipReader(httpReader));
  }
  const zipReader = zipReaderMap.get(remote_url);
  const entries = await zipReader.getEntries().catch(err => {console.error(err); return [];});
  const targetEntry = entries.find((entry) => entry.filename === target_file);

  if (!targetEntry) {
    console.error(`File "${target_file}" not found in ZIP archive.`);
    return new Response("File not found", { status: 404 });
  }

  console.log(`Found "${target_file}" in ZIP archive. Streaming...`);

  const stream = new TransformStream();
  targetEntry.getData(stream).catch(err => console.log("Stream was interruped", err));

  const ext = mime.contentType(target_file.split('.').slice(-1)[0]);

  return new Response(
      stream.readable,
      { headers: { "Content-Type": ext, "Cache-Control": cache_control}}
  );
});
