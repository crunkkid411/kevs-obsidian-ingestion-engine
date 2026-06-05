import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

/**
 * Write a markdown note into the Obsidian vault with YAML frontmatter.
 * - Uses the AI-generated summary as the note title
 * - Saves a thumbnail (first frame) as an attachment
 */
export async function writeToVault({ file, classification, transcript, sourceLink, frames }) {
  const vaultDir = path.join(config.obsidian.vaultPath, config.obsidian.notesFolder);
  const attachDir = path.join(config.obsidian.vaultPath, 'attachments');
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(attachDir, { recursive: true });

  const title = classification.summary || file.name.replace(/\.[^.]+$/, '');
  const slug = title
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80);

  const filePath = path.join(vaultDir, `${slug}.md`);

  let thumbnailEmbed = '';
  if (frames?.length > 0) {
    const thumbName = `${slug}-thumb.jpg`;
    const thumbDest = path.join(attachDir, thumbName);
    try {
      await fs.copyFile(frames[0].path, thumbDest);
      thumbnailEmbed = `![[attachments/${thumbName}]]`;
    } catch (err) {
      console.warn(`[Obsidian] Could not copy thumbnail: ${err.message}`);
    }
  }

  const frontmatter = buildFrontmatter({ file, classification, sourceLink });
  const body = buildBody({ classification, transcript, thumbnailEmbed });

  const content = `---\n${frontmatter}\n---\n\n${body}`;
  await fs.writeFile(filePath, content, 'utf-8');
  console.log(`[Obsidian] Wrote: ${filePath}`);
  return filePath;
}

function esc(str) {
  return (str || '').replace(/"/g, '\\"');
}

function buildFrontmatter({ file, classification, sourceLink }) {
  const projectTag = (config.taxonomy.project.name || 'KB').replace(/\s+/g, '-');

  const lines = [
    `title: "${esc(file.name)}"`,
    `source_id: "${file.id}"`,
    `source_link: "${sourceLink}"`,
    `content_type: "${classification.content_type}"`,
  ];

  if (classification.content_types_secondary?.length > 0) {
    lines.push(`content_types_secondary: [${classification.content_types_secondary.map((t) => `"${t}"`).join(', ')}]`);
  }

  lines.push(`topic_areas: [${(classification.topic_areas || []).map((a) => `"${a}"`).join(', ')}]`);
  lines.push(`gender: "${classification.gender}"`);
  lines.push(`location: "${classification.location || 'unknown'}"`);
  lines.push(`tone: "${classification.tone || 'unknown'}"`);
  lines.push(`production_quality: "${classification.production_quality || 'unknown'}"`);
  lines.push(`confidence: ${classification.confidence}`);
  lines.push(`summary: "${esc(classification.summary)}"`);
  lines.push(`date_processed: "${new Date().toISOString()}"`);
  lines.push(`status: "auto-tagged"`);

  if (classification.people_detected?.length > 0) {
    const names = classification.people_detected.map((p) => `"${esc(p.name)}"`).join(', ');
    lines.push(`people: [${names}]`);
  }

  if (classification.people_mentions?.length > 0) {
    lines.push(`people_mentions: [${classification.people_mentions.map((i) => `"${esc(i)}"`).join(', ')}]`);
  }

  // Build hierarchical tags
  const allTags = [
    projectTag,
    `${projectTag}/${classification.content_type.replace(/\s+/g, '-')}`,
    ...(classification.topic_areas || []).map((a) => `${projectTag}/topic/${a.replace(/\s+/g, '-')}`),
    `${projectTag}/gender/${classification.gender}`,
    `${projectTag}/location/${(classification.location || 'unknown').replace(/\s+/g, '-')}`,
    `${projectTag}/tone/${(classification.tone || 'unknown').replace(/\s+/g, '-')}`,
    ...(classification.people_detected || []).map((p) => `${projectTag}/person/${p.name.replace(/\s+/g, '-')}`),
    ...(classification.tags || []),
  ];
  lines.push(`tags: [${allTags.map((t) => `"${t}"`).join(', ')}]`);

  return lines.join('\n');
}

function buildBody({ classification, transcript, thumbnailEmbed }) {
  const sections = [];

  sections.push(`# ${classification.summary || 'Video'}\n`);

  if (thumbnailEmbed) {
    sections.push(`${thumbnailEmbed}\n`);
  }

  if (classification.people_detected?.length > 0) {
    const peopleLinks = classification.people_detected.map(
      (p) => `[[${p.name}]] (${p.role || 'subject'}, via ${p.detected_via || 'unknown'})`,
    );
    sections.push(`> **People:** ${peopleLinks.join(' | ')}\n`);
  }

  if (classification.people_mentions?.length > 0) {
    sections.push(`> **Mentions:** ${classification.people_mentions.map((i) => `[[${i}]]`).join(', ')}\n`);
  }

  if (classification.key_quotes?.length > 0) {
    sections.push(`## Key Quotes\n`);
    for (const q of classification.key_quotes) {
      const speaker = q.speaker ? `**${q.speaker}**` : '';
      const ts = q.timestamp_approx ? ` [${q.timestamp_approx}]` : '';
      sections.push(`> "${q.quote}" — ${speaker}${ts}\n`);
    }
  }

  if (classification.suggested_clips?.length > 0) {
    sections.push(`## Suggested Clips\n`);
    for (const clip of classification.suggested_clips) {
      sections.push(`- **${clip.start} → ${clip.end}**: ${clip.description}`);
    }
    sections.push('');
  }

  sections.push(`## Transcript\n`);
  if (transcript.segments?.length > 0) {
    for (const seg of transcript.segments) {
      const ts = formatTimestamp(seg.start);
      sections.push(`**[${ts}]** ${seg.text}\n`);
    }
  } else {
    sections.push(transcript.text);
  }

  return sections.join('\n');
}

function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
