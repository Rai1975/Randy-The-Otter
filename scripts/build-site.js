const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

const root = path.resolve(__dirname, "..");
const siteDir = path.join(root, "site");
const extensionDir = path.join(root, "extenstion");
const publicDir = path.join(root, "public");
const publicAssetsDir = path.join(publicDir, "assets");
const downloadsDir = path.join(publicDir, "downloads");
const zipPath = path.join(downloadsDir, "randy-the-otter-extension.zip");

function removeIfExists(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
}

function createExtensionZip() {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      console.log(`Created ${path.relative(root, zipPath)} (${archive.pointer()} bytes)`);
      resolve();
    });
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(extensionDir, false);
    archive.finalize();
  });
}

async function build() {
  removeIfExists(publicDir);
  fs.mkdirSync(publicAssetsDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  copyDirectory(siteDir, publicDir);
  copyDirectory(path.join(extensionDir, "src", "assets"), publicAssetsDir);
  await createExtensionZip();
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
