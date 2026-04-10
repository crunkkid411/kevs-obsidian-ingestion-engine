import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

const anthropic = new Anthropic({ apiKey: config.ai.anthropicApiKey });

/**
 * Build a flat list of "Name (also: alias1, alias2)" for the prompt.
 */
function buildPeopleList() {
  const people = config.taxonomy.people_of_interest || [];
  if (people.length === 0) return '(none defined)';
  return people.map((p) => {
    if (p.aliases?.length) return `${p.name} (also: ${p.aliases.join(', ')})`;
    return p.name;
  }).join('\n    ');
}

/**
 * Extract metadata clues from the video filename.
 * Filenames often contain: people names, @handles, #hashtags, topic keywords.
 */
function parseFilenameMetadata(fileName) {
  const hints = [];

  const handles = fileName.match(/@[\w.]+/g) || [];
  if (handles.length > 0) {
    hints.push(`Social handles in filename: ${handles.join(', ')}`);
  }

  const hashtags = fileName.match(/#[\w]+/g) || [];
  if (hashtags.length > 0) {
    hints.push(`Hashtags in filename: ${hashtags.join(', ')}`);
  }

  // Match people-of-interest names against filename (word boundary, case-insensitive)
  const people = config.taxonomy.people_of_interest || [];
  const matchedPeople = [];
  for (const p of people) {
    const names = [p.name, ...(p.aliases || [])];
    for (const name of names) {
      const parts = name.toLowerCase().split(/\s+/);
      const lastName = parts[parts.length - 1];
      const fullName = parts.join(' ');
      const regex = lastName.length >= 5
        ? new RegExp(`\\b${lastName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
        : new RegExp(`\\b${fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (regex.test(fileName)) {
        matchedPeople.push(p.name);
        break;
      }
    }
  }
  if (matchedPeople.length > 0) {
    hints.push(`People-of-interest detected in filename: ${matchedPeople.join(', ')}`);
  }

  return {
    handles,
    hashtags,
    matchedPeople,
    hints: hints.length > 0 ? hints.join('\n') : 'No metadata found in filename.',
  };
}

/**
 * Classify a video using transcript + vision context + filename metadata.
 * Returns structured classification matching the user-defined taxonomy.
 */
export async function classifyVideo({ transcript, visionAnalysis, fileName }) {
  console.log(`[Classify] Running classification for: ${fileName}`);

  const t = config.taxonomy;
  const filenameMeta = parseFilenameMetadata(fileName);
  if (filenameMeta.matchedPeople.length > 0) {
    console.log(`[Classify] Filename match: ${filenameMeta.matchedPeople.join(', ')}`);
  }

  const prompt = `You are a content classification agent for: ${t.project.name}

${t.project.context}

## FILENAME METADATA
**Original filename:** ${fileName}
${filenameMeta.hints}

## TAXONOMY

**Content Type** (pick PRIMARY, list any SECONDARY):
    ${t.content_types.join(', ')}

**Topic Areas** (pick ALL that apply):
    ${t.topic_areas.join(', ')}

**Gender** (of primary subject):
    ${t.genders.join(', ')}

**Location / Setting**:
    ${t.locations.join(', ')}

**Tone**:
    ${t.tones.join(', ')}

**Production Quality**:
    ${t.production_qualities.join(', ')}

**Known People of Interest** (flag if mentioned in transcript OR visible):
    ${buildPeopleList()}

## VIDEO: ${fileName}

### TRANSCRIPT
${transcript.text}

### VISUAL ANALYSIS
${JSON.stringify(visionAnalysis, null, 2)}

## INSTRUCTIONS
1. **Content type**: Use transcript style + visual cues to pick the best fit.
2. **Topic areas**: List ALL topics discussed or shown.
3. **People detection**: Scan the transcript carefully for ANY name from the list above. Note if they appear ON SCREEN based on visual analysis.
4. **Location**: Determine where the video was filmed.
5. **Key quotes**: Pull 2-3 most compelling/quotable moments verbatim.
6. **Suggested clips**: Identify 1-3 notable moments with approximate timestamps.

${t.additional_instructions ? `## PROJECT-SPECIFIC GUIDANCE\n${t.additional_instructions}\n` : ''}

Return ONLY valid JSON (no markdown fences):
{
  "content_type": "primary type from list",
  "content_types_secondary": ["any additional types"],
  "topic_areas": ["all that apply"],
  "gender": "from gender list",
  "people_detected": [
    {"name": "Person Name", "detected_via": "transcript|vision|both", "role": "speaker|guest|host|subject|other"}
  ],
  "people_mentions": ["names from the known list only"],
  "location": "from location list",
  "tone": "from tone list",
  "production_quality": "from quality list",
  "confidence": 0.0-1.0,
  "summary": "One-line description of the video content",
  "key_quotes": [
    {"quote": "exact quote from transcript", "speaker": "who said it", "timestamp_approx": "M:SS"}
  ],
  "suggested_clips": [
    {"start": "M:SS", "end": "M:SS", "description": "why this moment is notable"}
  ],
  "tags": ["any additional relevant tags"]
}`;

  const response = await anthropic.messages.create({
    model: config.ai.model,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse classification JSON');
  }

  const classification = JSON.parse(jsonMatch[0]);
  console.log(`[Classify] Result: ${classification.content_type} | ${(classification.topic_areas || []).join(', ')}`);
  if (classification.people_mentions?.length > 0) {
    console.log(`[Classify] People: ${classification.people_mentions.join(', ')}`);
  }
  return classification;
}
