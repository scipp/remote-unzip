# remote-unzip

Deno application that reads remote zip files and unzips them on the fly.

Direct artifact and release asset URLs take precedence. Other URLs use the form
`/owner/repo/ref/file`: the exact ref name is looked up as a Git tag first, then
as a branch if that tag does not exist. This applies to every name, including
`main`, `nightly`, `1.2.3`, and `v1.2.3`; `v1.2.3` and `1.2.3` are distinct
names.

Direct Actions artifact URLs can use `artifacts/{id}`, `actions/artifacts/{id}`,
or the standard GitHub form `actions/runs/{run_id}/artifacts/{id}` after
`/owner/repo/`. Append a path to select a file inside the archive.

For branch or tag names containing slashes, encode each slash as `%2F`. For
example, to read `docs/index.html` from a documentation asset on the release tag
`release/1.2.3`, use:

```text
https://remote-unzip.scipp.deno.net/scipp/ess/release%2F1.2.3/docs/index.html
```

Slashes after the encoded ref belong to the path inside the ZIP archive. A tag
takes precedence over a branch with the same name, even if the tag has no
release or documentation ZIP; those cases return 404. A missing tag and branch
also returns 404. Other GitHub errors return 502 instead of changing the
interpretation.

The release must contain a ZIP asset whose name starts with `documentation`.
When the file path is omitted, the default is `index.html` inside a directory
matching the ZIP's base name: `documentation-1.2.3.zip` defaults to
`documentation-1.2.3/index.html`. Specify the file path for other archive
layouts.

Branch artifact names can be selected with `?artifact_name=docs_html`. Use a
comma-separated fallback list (`?artifact_name=docs_html,html`) or repeat the
parameter (`?artifact_name=docs_html&artifact_name=html`). Query parameters use
standard URL decoding, so `%2C` also separates names. Nonempty names, including
whitespace, are preserved. Empty list entries are ignored; if no names remain,
the usual defaults apply: `docs_html`, or `docs_html,html,DocumentationHTML` for
a repository named `scipp` regardless of capitalization. The name order is
applied within each workflow run. This option selects branch artifacts; release
assets are selected by the naming rule above.

Directory paths ending in `/` serve their `index.html`. A directory path without
the final slash redirects to add it when that index exists, preserving query
parameters so relative links resolve correctly. An exact file takes precedence.

Archive download or ZIP metadata failures return 502; missing files return 404.
If extraction fails after the streaming response starts, the response body
fails.

Run the tests with `deno test --allow-env=GITHUB_TOKEN_NOPERMISSIONS`.
