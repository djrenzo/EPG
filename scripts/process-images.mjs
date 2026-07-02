// scripts/process-images.mjs
//
// Scans guide.xml for <icon src="..."/> URLs (channel logos + programme
// images), downloads any URL not already in images/manifest.json, downsizes
// it, saves it under images/, and rewrites the URL in guide.xml to point at
// the raw.githubusercontent.com copy. Already-processed URLs are looked up
// in the manifest and just get their URL swapped, no re-download.

import { readFile, writeFile, mkdir } from "fs/promises";
import { createHash } from "crypto";
import path from "path";
import sharp from "sharp";

const GUIDE_PATH = "guide.xml";
const IMAGES_DIR = "images";
const MANIFEST_PATH = path.join(IMAGES_DIR, "manifest.json");
const MAX_WIDTH = 300; // px - plenty for an EPG grid cell/thumbnail
const PNG_COMPRESSION_LEVEL = 9;

const repo = process.env.GITHUB_REPOSITORY; // "owner/repo"
const branch = process.env.GITHUB_REF_NAME || "main";

if (!repo) {
  console.error("GITHUB_REPOSITORY env var is required.");
  process.exit(1);
}

function rawUrlFor(localPath) {
  return `https://raw.githubusercontent.com/${repo}/${branch}/${localPath}`;
}

async function loadManifest() {
  try {
    const raw = await readFile(MANIFEST_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveManifest(manifest) {
  await mkdir(IMAGES_DIR, { recursive: true });
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

function hashUrl(url) {
  return createHash("sha1").update(url).digest("hex").slice(0, 16);
}

async function downloadAndDownsize(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (EPG-image-cache-bot)" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());

  const resized = await sharp(buffer)
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .png({ compressionLevel: PNG_COMPRESSION_LEVEL })
    .toBuffer();

  return resized;
}

async function main() {
  let xml = await readFile(GUIDE_PATH, "utf8");

  // Matches <icon ... src="URL" ... /> and captures the URL, for both
  // channel logos and the programme <icon> tags produced by the sed step.
  const iconRegex = /(<icon\b[^>]*\bsrc=")([^"]+)("[^>]*\/?>)/g;

  const urls = new Set();
  for (const match of xml.matchAll(iconRegex)) {
    urls.add(match[2]);
  }

  console.log(`Found ${urls.size} unique icon URL(s) in ${GUIDE_PATH}.`);

  const manifest = await loadManifest();
  const urlToRawUrl = new Map();
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const url of urls) {
    // Never try to re-process a URL that's already our own raw github link
    // (defensive - shouldn't normally happen since guide.xml is regenerated
    // fresh from source each run).
    if (url.startsWith(`https://raw.githubusercontent.com/${repo}/`)) {
      continue;
    }

    if (manifest[url]) {
      urlToRawUrl.set(url, rawUrlFor(manifest[url]));
      skipped++;
      continue;
    }

    try {
      const resized = await downloadAndDownsize(url);
      const filename = `${hashUrl(url)}.png`;
      const localPath = path.join(IMAGES_DIR, filename);

      await mkdir(IMAGES_DIR, { recursive: true });
      await writeFile(localPath, resized);

      manifest[url] = localPath;
      urlToRawUrl.set(url, rawUrlFor(localPath));
      downloaded++;
      console.log(`Downloaded + resized: ${url} -> ${localPath}`);
    } catch (err) {
      failed++;
      console.warn(`Skipping (failed to fetch/process): ${url} — ${err.message}`);
      // Leave the original URL in guide.xml untouched for this one.
    }
  }

  // Rewrite guide.xml with local raw-github URLs where we have them.
  xml = xml.replace(iconRegex, (full, pre, url, post) => {
    const rawUrl = urlToRawUrl.get(url);
    return rawUrl ? `${pre}${rawUrl}${post}` : full;
  });

  await writeFile(GUIDE_PATH, xml);
  await saveManifest(manifest);

  console.log(
    `Done. ${downloaded} newly downloaded, ${skipped} reused from manifest, ${failed} failed/skipped.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
