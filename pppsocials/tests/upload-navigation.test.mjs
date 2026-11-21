import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);

async function loadPage(relativePath, mocks, globals = {}) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  const mockRequire = (name) => name in mocks ? mocks[name] : require(name);
  const names = Object.keys(globals);
  new Function("require", "exports", ...names, compiled)(
    mockRequire, exports, ...names.map((name) => globals[name])
  );
  return exports.default;
}

function hooks() {
  const values = [];
  let index = 0;
  return {
    render(component) {
      index = 0;
      return component();
    },
    react: {
      useState(initial) {
        const current = index++;
        if (!(current in values)) values[current] = initial;
        return [values[current], (value) => {
          values[current] = typeof value === "function" ? value(values[current]) : value;
        }];
      },
      useRef(initial) {
        const current = index++;
        if (!(current in values)) values[current] = { current: initial };
        return values[current];
      },
      useEffect() {},
    },
  };
}

function find(element, predicate) {
  if (!element || typeof element !== "object") return null;
  if (predicate(element)) return element;
  for (const child of [element.props?.children].flat(Infinity)) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

async function uploadHarness(matches = []) {
  const state = hooks();
  const navigations = [];
  const requests = [];
  class MockRequest {
    upload = {};
    constructor() { requests.push(this); }
    open() {}
    send() {}
  }
  const page = await loadPage("../app/(protected)/upload/page.tsx", {
    react: state.react,
    "next/navigation": { useRouter: () => ({ push: (url) => navigations.push(url) }) },
  }, {
    fetch: async () => ({ ok: true, json: async () => matches }),
    XMLHttpRequest: MockRequest,
    window: { confirm: () => true },
  });
  let tree = state.render(page);
  find(tree, (element) => element.type === "input" && element.props.type === "file")
    .props.onChange({ target: { files: [new File(["video"], "clip.mp4")] } });
  tree = state.render(page);
  await find(tree, (element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  if (matches.length) {
    tree = state.render(page);
    find(tree, (element) => element.type === "button" && element.props.children === "Replace this video")
      .props.onClick();
  }
  return { request: requests[0], navigations, render: () => state.render(page) };
}

test("opens the library only after the server confirms the upload", async () => {
  const { request, navigations } = await uploadHarness();
  request.upload.onload();
  assert.deepEqual(navigations, []);
  request.status = 200;
  request.response = { success: true };
  request.onload();
  assert.deepEqual(navigations, ["/library?upload=complete"]);
});

test("replacement opens the library with its cleanup warning", async () => {
  const match = { id: "4", title: "Video", filename: "old.mp4" };
  const { request, navigations } = await uploadHarness([match]);
  request.status = 200;
  request.response = { success: true, warning: "Old file could not be removed." };
  request.onload();
  assert.deepEqual(navigations, [
    "/library?upload=replaced&warning=Old+file+could+not+be+removed.",
  ]);
});

test("failed uploads stay on the upload page and show the error", async () => {
  const { request, navigations, render } = await uploadHarness();
  request.status = 500;
  request.response = { message: "Unable to save video." };
  request.onload();
  assert.deepEqual(navigations, []);
  assert.equal(find(render(), (element) => element.props?.role === "alert").props.children, "Unable to save video.");
});

test("library displays the upload result and warning", async () => {
  const state = hooks();
  const params = new URLSearchParams("upload=replaced&warning=Old+file+could+not+be+removed.");
  const page = await loadPage("../app/(protected)/library/page.tsx", {
    react: { ...state.react, Suspense: Symbol("Suspense") },
    "next/navigation": { useSearchParams: () => params },
    "@/app/components/StoryPublish": { default: () => null },
  });
  const tree = state.render(page);
  const notice = find(tree, (element) => typeof element.type === "function" && element.type.name === "UploadNotice");
  assert.deepEqual(notice.type().props.children, ["Video replaced.", " Old file could not be removed."]);
});
