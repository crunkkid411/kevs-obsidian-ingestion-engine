import { Dropbox } from 'dropbox';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.webm', '.mkv'];

let dbx = null;
function getClient() {
  if (!dbx) dbx = new Dropbox({ accessToken: config.dropbox.accessToken });
  return dbx;
}

export async function listVideos(folderPath) {
  const client = getClient();
  let allEntries = [];
  let res = await client.filesListFolder({ path: folderPath, recursive: true, limit: 2000 });
  allEntries = allEntries.concat(res.result.entries);
  while (res.result.has_more) {
    res = await client.filesListFolderContinue({ cursor: res.result.cursor });
    allEntries = allEntries.concat(res.result.entries);
  }

  const videos = allEntries.filter((e) =>
    e['.tag'] === 'file' && VIDEO_EXTENSIONS.includes(path.extname(e.name).toLowerCase()),
  );

  return videos.map((f) => ({
    id: f.id,
    name: f.name,
    path: f.path_display,
    size: f.size,
    createdTime: f.server_modified,
    source: 'dropbox',
  }));
}

export async function downloadVideo(file) {
  const client = getClient();
  await fs.mkdir(config.tempDir, { recursive: true });
  const destPath = path.join(config.tempDir, file.name);

  try {
    await fs.access(destPath);
    console.log(`[Dropbox] Already downloaded: ${file.name}`);
    return destPath;
  } catch { /* download */ }

  console.log(`[Dropbox] Downloading: ${file.name} (${file.size} bytes)`);
  const res = await client.filesDownload({ path: file.path });
  await fs.writeFile(destPath, Buffer.from(res.result.fileBinary));
  console.log(`[Dropbox] Saved to: ${destPath}`);
  return destPath;
}

export async function getShareLink(file) {
  const client = getClient();
  try {
    const res = await client.sharingCreateSharedLinkWithSettings({ path: file.path });
    return res.result.url;
  } catch (err) {
    if (err?.error?.error?.['.tag'] === 'shared_link_already_exists') {
      const links = await client.sharingListSharedLinks({ path: file.path, direct_only: true });
      if (links.result.links.length > 0) return links.result.links[0].url;
    }
    return `dropbox://${file.path}`;
  }
}
