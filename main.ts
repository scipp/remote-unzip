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
  // If not found, look for url like org/repo/assets/xxxxx/file
  if (remote_url === undefined) {
      const groups = url.pathname.match(/\/([^\/]*)\/([^\/]*)\/.*assets\/(\d{9})\/?(.*)/);
      if (groups !== null) {
          const owner = groups[1];
          const repo = groups[2];
          const asset = groups[3];
          console.log({owner, repo, asset});
          target_file = groups[4];
          remote_url = `https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset}`;
          opts.headers['Accept'] = 'application/octet-stream';
          opts.redirect = 'follow';
      }
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

          if (branch.match(/^v?[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$/)) {
              // branch is a release tag name - fetch from release assets
              const tag = branch[0] == 'v' ? branch.slice(1) : branch;
              const release = (await (await fetch(
                  `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`,
                  opts,
              )).json());
              const assets = await (await fetch(release.assets_url)).json();
              for (const asset of assets) {
                  if (asset.name.match(/documentation.*/)) {
                      if (target_file == '') {
                          target_file = `documentation-${tag}/index.html`;
                      }
                      console.log(
                          'Redirecting to',
                          `${url.origin}/${owner}/${repo}/assets/${asset.id}/${target_file}`,
                      );
                      return Response.redirect(
                          `${url.origin}/${owner}/${repo}/assets/${asset.id}/${target_file}`,
                           302,
                      );
                  }
              }
          }
          else {
              try {
                  // Retreive relatively few per page - hopefully we won't need to fetch many anyway, so it won't increase latency much.
                  const per_page = 10;
                  // Retreive runs on branch, for each run, retreive the first artifact that has "docs_html" name.
                  // Assume that one of the first per_page * 10 workflow runs has a docs build.
                  for (let page=1; page < 10; page++) {
                      const runs = (await (await fetch(
                          `https://api.github.com/repos/${owner}/${repo}/actions/runs?branch=${branch}&page=${page}&per_page=${per_page}`,
                          opts,
                      )).json()).workflow_runs;
                      for (const run of runs) {
                          const artifact_names = repo === 'scipp' ? ['docs_html', 'html', 'DocumentationHTML'] : ['docs_html'];
                          for (const artifact_name of artifact_names) {
                              const artifacts = (await (await fetch(
                                  `https://api.github.com/repos/${owner}/${repo}/actions/runs/${run.id}/artifacts?name=${artifact_name}&per_page=1`,
                                  opts,
                              )).json()).artifacts;
                              if (artifacts.length != 0) {
                                  console.log(
                                      'Redirecting to',
                                      `${url.origin}/${owner}/${repo}/actions/artifacts/${artifacts[0].id}/${target_file}`,
                                  );
                                  return Response.redirect(
                                      `${url.origin}/${owner}/${repo}/actions/artifacts/${artifacts[0].id}/${target_file}`,
                                       302,
                                  );
                              }
                          }
                      }
                      if (runs.length < per_page) {
                          // Retreived fewer than requested, we reached the end of the list.
                          break;
                      }
                  }
                  return new Response(
                      "No docs artifact was found on that branch", { status: 404 }
                  );
              } catch (e) {
                  console.log("Error when fetching latest docs from branch ", e);
                  return new Response(
                      "Failed to fetch latest docs from branch", { status: 500 }
                  );
              }
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
