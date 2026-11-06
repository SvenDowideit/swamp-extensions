import { assert, assertEquals } from "jsr:@std/assert@1";

import {
  handleRequest,
  htmlBasenameFromPath,
  parentDir,
} from "./feedback-server.ts";

function request(path: string): Request {
  return new Request(`http://127.0.0.1:8765${path}`);
}

async function serve(
  req: Request,
  dirs: { pages: string; htmlPath: string; htmlDir: string },
): Promise<Response | null> {
  return await handleRequest(
    req,
    dirs.htmlPath,
    dirs.htmlDir,
    "",
    "",
    "",
    dirs.pages,
    dirs.pages,
    dirs.pages,
  );
}

Deno.test("parentDir strips the file name", () => {
  assertEquals(parentDir("/a/b/news.html"), "/a/b");
  assertEquals(parentDir("/a/b/"), "/a/b");
  assertEquals(parentDir("/news.html"), "/");
  assertEquals(parentDir("news.html"), ".");
});

Deno.test("htmlBasenameFromPath accepts plain html names only", () => {
  assertEquals(htmlBasenameFromPath("/later.html"), "later.html");
  assertEquals(htmlBasenameFromPath("/feeds.html"), "feeds.html");
  assertEquals(htmlBasenameFromPath("/news.html?x=1"), null);
  assertEquals(htmlBasenameFromPath("/sub/x.html"), null);
  assertEquals(htmlBasenameFromPath("/%2e%2e/etc.html"), null);
  assertEquals(htmlBasenameFromPath("/style.css"), null);
});

Deno.test("serves an html file created after the server started", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const pages = `${dir}/pages`;
    await Deno.mkdir(pages);
    const htmlPath = `${pages}/news.html`;
    await Deno.writeTextFile(htmlPath, "<h1>news</h1>");
    const dirs = { pages, htmlPath, htmlDir: pages };

    const first = await serve(request("/news.html"), dirs);
    assert(first);
    assertEquals(first.status, 200);
    assertEquals(await first.text(), "<h1>news</h1>");

    await Deno.writeTextFile(`${pages}/later.html`, "<h1>later</h1>");

    const later = await serve(request("/later.html"), dirs);
    assert(later);
    assertEquals(later.status, 200);
    assertEquals(await later.text(), "<h1>later</h1>");
    assertEquals(later.headers.get("content-type"), "text/html; charset=utf-8");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("root falls back to index.html in the pages directory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const pages = `${dir}/pages`;
    await Deno.mkdir(pages);
    await Deno.writeTextFile(`${pages}/index.html`, "<h1>index</h1>");
    const dirs = {
      pages,
      htmlPath: `${pages}/news.html`,
      htmlDir: pages,
    };

    const res = await serve(request("/"), dirs);
    assert(res);
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "<h1>index</h1>");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("does not escape the pages directory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const pages = `${dir}/pages`;
    await Deno.mkdir(pages);
    await Deno.writeTextFile(`${dir}/secret.html`, "<h1>secret</h1>");
    const dirs = {
      pages,
      htmlPath: `${pages}/news.html`,
      htmlDir: pages,
    };

    for (
      const path of [
        "/../secret.html",
        "/%2e%2e/secret.html",
        "/sub/secret.html",
      ]
    ) {
      const res = await serve(request(path), dirs);
      assert(res);
      assertEquals(res.status, 404);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
