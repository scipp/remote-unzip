import { ZipReader, HttpRangeReader, TextWriter } from "https://deno.land/x/zipjs@v2.7.24/index.js";
import { mime, mimelite } from "https://raw.githubusercontent.com/Tyrenn/mimetypes/refs/heads/main/src/mime.ts";

const token = Deno.env.get("GITHUB_TOKEN_NOPERMISSIONS");
console.log("Found token:", !!token)

const zipReaderMap = new Map();


Deno.serve(async (req) => {
  const url = new URL(req.url);

  const groups = url.pathname.match(/\/([^\/]*)\/([^\/]*)\/.*artifacts\/(\d{10})\/?(.*)/);
  if (groups == null) {
      return new Response("No artifact path provided. Provide a valid github artifact url.", { status: 404 });
  }
  const owner = groups[1];
  const repo = groups[2];
  const artifact = groups[3];
  let target_file = groups[4];

  if (target_file == '') {
      target_file = 'index.html';

      if (req.url.slice(-1) !== '/') {
          return Response.redirect(req.url + '/');
      }
  }
  console.log({owner, repo, artifact});

  const remote_url = `https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${artifact}/zip`
  console.log(remote_url, target_file);
  const opts = {
    headers: {
      Authorization: `token ${token}`,
    },
  };
  
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
  targetEntry.getData(stream);

  const ext = mime.getType(target_file.split('.').slice(-1)[0]);

  return new Response(
      stream.readable,
      { headers: { "Content-Type": ext, "Cache-Control": "max-age=31536000"}}
  );
});
