import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acceptMatches, resolveUploadPath, validateUploadFiles } from "../file-upload.js";

const single = { multiple: false, accept: "", disabled: false };
const fileStat = () => ({ isFile: () => true });

describe("acceptMatches", () => {
  it("accepts anything when accept is empty", () => {
    assert.ok(acceptMatches("", "/a/b.bin"));
    assert.ok(acceptMatches(undefined, "/a/b.bin"));
  });

  it("matches extensions case-insensitively", () => {
    assert.ok(acceptMatches(".pdf, .DOCX", "C:\\Users\\me\\Report.PDF"));
    assert.ok(acceptMatches(".pdf,.docx", "/tmp/x.docx"));
    assert.ok(!acceptMatches(".pdf", "/tmp/x.png"));
  });

  it("matches MIME types and wildcards via the extension", () => {
    assert.ok(acceptMatches("image/*", "/tmp/a.JPG"));
    assert.ok(acceptMatches("application/pdf", "/tmp/a.pdf"));
    assert.ok(!acceptMatches("image/*", "/tmp/a.pdf"));
    assert.ok(!acceptMatches("image/png,.gif", "/tmp/a.txt"));
  });

  it("does not reject when the MIME type of the file is unknown", () => {
    assert.ok(acceptMatches("application/x-custom", "/tmp/a.weird"));
  });
});

describe("resolveUploadPath", () => {
  it("normalizes Windows absolute paths on win32", () => {
    assert.equal(resolveUploadPath("C:/Users/me/a.pdf", "D:\\work", "win32"), "C:\\Users\\me\\a.pdf");
    assert.equal(resolveUploadPath("C:\\Users\\me\\a.pdf", "D:\\work", "win32"), "C:\\Users\\me\\a.pdf");
    assert.equal(resolveUploadPath("docs\\a.pdf", "D:\\work", "win32"), "D:\\work\\docs\\a.pdf");
  });

  it("resolves relative POSIX paths against cwd", () => {
    assert.equal(resolveUploadPath("./a.png", "/home/me", "linux"), "/home/me/a.png");
  });
});

describe("validateUploadFiles", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ma-upload-"));
  const pdf = path.join(dir, "a.pdf");
  const png = path.join(dir, "b.png");
  writeFileSync(pdf, "%PDF-1.4");
  writeFileSync(png, "png");
  mkdirSync(path.join(dir, "sub"));

  it("returns absolute paths for valid files", () => {
    assert.deepEqual(validateUploadFiles([pdf], single), [pdf]);
    assert.deepEqual(validateUploadFiles([pdf, png], { ...single, multiple: true }), [pdf, png]);
  });

  it("accepts Windows absolute paths on win32", () => {
    assert.deepEqual(
      validateUploadFiles(["C:/Users/me/a.pdf"], { ...single, accept: ".pdf" }, { platform: "win32", stat: fileStat }),
      ["C:\\Users\\me\\a.pdf"],
    );
  });

  it("rejects missing files, directories and relative paths", () => {
    assert.throws(() => validateUploadFiles([path.join(dir, "nope.pdf")], single), /File not found: .*nope\.pdf/);
    assert.throws(() => validateUploadFiles([path.join(dir, "sub")], single), /Not a regular file/);
    assert.throws(() => validateUploadFiles(["a.pdf"], single), /must be absolute/);
    assert.throws(() => validateUploadFiles([], single), /Missing files/);
  });

  it("rejects multiple files on a single-file input", () => {
    assert.throws(() => validateUploadFiles([pdf, png], single), /does not accept multiple files \(got 2\)/);
  });

  it("rejects accept mismatches unless forced", () => {
    assert.throws(() => validateUploadFiles([png], { ...single, accept: ".pdf" }), /does not match the input's accept="\.pdf"/);
    assert.deepEqual(validateUploadFiles([png], { ...single, accept: ".pdf" }, { force: true }), [png]);
  });

  it("rejects disabled inputs", () => {
    assert.throws(() => validateUploadFiles([pdf], { ...single, disabled: true }), /disabled/);
  });
});
