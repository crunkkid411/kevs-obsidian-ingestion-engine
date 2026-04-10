import Anthropic from '@anthropic-ai/sdk';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');

const anthropic = new Anthropic({ apiKey: config.ai.anthropicApiKey });

/**
 * Extract key frames using OpenCV scene detection.
 */
export async function extractFrames(videoPath) {
  const framesDir = path.join(
    config.tempDir, 'frames',
    path.basename(videoPath, path.extname(videoPath)),
  );
  const scriptPath = path.join(SCRIPTS_DIR, 'extract_frames.py');

  console.log(`[Vision] Extracting frames with OpenCV: ${path.basename(videoPath)}`);

  const { stdout, stderr } = await execAsync(
    `python3 "${scriptPath}" "${videoPath}" "${framesDir}" --max-frames 6`,
    { maxBuffer: 10 * 1024 * 1024, timeout: 300_000 },
  );

  if (stderr) {
    for (const line of stderr.split('\n').filter(Boolean)) {
      console.log(`[Vision] ${line}`);
    }
  }

  const result = JSON.parse(stdout);
  console.log(
    `[Vision] Extracted ${result.frames_extracted} frames ` +
    `(${result.scene_changes_detected} scene changes detected)`,
  );

  return result.frames;
}

/**
 * Analyze extracted frames using Claude Vision.
 * Includes OpenCV pre-analysis (faces, sharpness, brightness) as extra context.
 */
export async function analyzeFrames(frames) {
  const imageContents = await Promise.all(
    frames.map(async (frame) => {
      const data = await fs.readFile(frame.path);
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: data.toString('base64'),
        },
      };
    }),
  );

  const cvContext = frames.map((f) =>
    `Frame ${f.frame_number} (${formatTimestamp(f.timestamp)}): ` +
    `${f.faces_detected} face(s), ${f.upper_bodies_detected} upper body(ies), ` +
    `brightness=${f.brightness}, sharpness=${f.sharpness}, res=${f.resolution}`,
  ).join('\n');

  const projectContext = config.taxonomy.project.context || '';

  const response = await anthropic.messages.create({
    model: config.ai.model,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          ...imageContents,
          {
            type: 'text',
            text: `You are analyzing frames from a video for the following project:

${projectContext}

## OpenCV pre-analysis
${cvContext}

## For each frame, identify:
1. **Gender**: male / female / unknown (of person on screen)
2. **Subject / focus**: What is the visual focus (a person speaking, an object, a procedure, a scene, etc.)
3. **Content type indicators**: What type of content this looks like (testimonial, b-roll, podcast, hook, procedure footage, etc.)

Return JSON:
{
  "frames": [
    {
      "frame_number": 1,
      "gender": "male|female|unknown",
      "subject": "string",
      "content_indicators": "string"
    }
  ],
  "overall_gender": "male|female|mixed|unknown",
  "primary_subject": "string",
  "primary_content_type": "string"
}`,
          },
        ],
      },
    ],
  });

  const text = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse vision analysis JSON');
  }

  const analysis = JSON.parse(jsonMatch[0]);
  console.log(`[Vision] Analysis complete: ${analysis.primary_content_type}, ${analysis.primary_subject}`);
  return analysis;
}

function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
