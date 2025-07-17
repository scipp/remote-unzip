import { ZipReader, HttpRangeReader, TextWriter } from "https://deno.land/x/zipjs@v2.7.24/index.js";
import * as mime from "npm:mime-types";

const token = Deno.env.get("GITHUB_TOKEN_NOPERMISSIONS");
console.log("Found token:", !!token)

const zipReaderMap = new Map();

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
          try {
              for (let page=0; page < 5; page++) {
                  const artifacts = (await (await fetch(
                      `https://api.github.com/repos/${owner}/${repo}/actions/artifacts?name=docs_html&page=${page}`,
                      opts,
                  )).json()).artifacts;
                  for (const artifact of artifacts) {
                      if (artifact.workflow_run.head_branch == branch) {
                          console.log(
                              'Redirecting to',
                              `${url.origin}/${owner}/${repo}/actions/artifacts/${artifact.id}/${target_file}`,
                          );
                          return Response.redirect(
                              `${url.origin}/${owner}/${repo}/actions/artifacts/${artifact.id}/${target_file}`,
                               302,
                          );
                      }
                  }
              }
              return new Response(
                  "No recent docs artifact found on that branch", { status: 404 }
              );
          } catch (e) {
              console.log("Error when fetching latest docs from branch ", e);
              return new Response(
                  "Failed to fetch latest docs from branch", { status: 500 }
              );
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
