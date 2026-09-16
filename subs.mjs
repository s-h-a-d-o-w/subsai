import { spawn } from 'child_process';
import { readdir, access, readFile, writeFile } from 'fs/promises';
import { dirname, join, parse } from 'path';
import { fileURLToPath } from 'url';

const ADDED_DURATION = 1500
const TOKEN = process.env.HF_TOKEN
const MERGE_CHARACTER_THRESHOLD = TOKEN ? 66 : 40;
const MERGE_TIME_THRESHOLD = 2000
const subsaiCommand = TOKEN ? (file) => `subsai "${file}" --format srt --translation-source-lang en --model m-bain/whisperX --model-configs "{\\"model_type\\": \\"large-v2\\", \\"diarize\\": true, \\"hf_token\\": \\"${TOKEN}\\", \\"device\\": \\"cuda\\", \\"batch_size\\": 4}"` : (file) => `subsai "${file}" --format srt --translation-source-lang en --model m-bain/whisperX --model-configs "{\\"model_type\\": \\"large-v2\\", \\"device\\": \\"cuda\\", \\"batch_size\\": 4}"`

const repoDir = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';
const activate = isWindows
  ? `"${join(repoDir, 'Scripts', 'activate.bat')}"`
  : `. "${join(repoDir, '.venv', 'bin', 'activate')}"`;
const deactivate = isWindows
  ? `"${join(repoDir, 'Scripts', 'deactivate.bat')}"`
  : 'deactivate';

async function runCommand(command) {
  const wrappedCommand = `${activate} && ${command} && ${deactivate}`;

  return new Promise((resolve, reject) => {
    const proc = isWindows
      ? spawn(`cmd /c`, [wrappedCommand], { shell: true })
      : spawn(wrappedCommand, { shell: true });
    proc.stdout.pipe(process.stdout);
    proc.stderr.pipe(process.stderr);

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

function parseTimestamp(timestamp) {
  const [time, millis] = timestamp.split(',');
  const [hours, minutes, seconds] = time.split(':').map(Number);

  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number(millis);
}

function formatTimestamp(ms) {
  const millis = ms % 1000;
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  const pad = (value, length = 2) => String(value).padStart(length, '0');

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

function parseSrt(content) {
  return content.trim().split(/\r?\n\r?\n/).map((block) => {
    const lines = block.split(/\r?\n/);
    const [start, end] = lines[1].split(' --> ');

    return {
      start: parseTimestamp(start),
      end: parseTimestamp(end),
      text: lines.slice(2).join('\n'),
    };
  });
}

function serializeSrt(cues) {
  return cues
    .map((cue, i) => `${i + 1}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.text}`)
    .join('\n\n') + '\n';
}

function getSpeaker(text) {
  return text.match(/^SPEAKER_\d+: /)?.[0];
}

async function mergeSubtitles(srtPath) {
  const content = await readFile(srtPath, 'utf-8');
  const cues = parseSrt(content);

  const merged = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const next = cues[i + 1];
    if (next && cue.text.length + next.text.length < MERGE_CHARACTER_THRESHOLD && next.start - cue.end < MERGE_TIME_THRESHOLD) {
      const speaker = getSpeaker(cue.text.split('\n').at(-1));
      const nextText = speaker && getSpeaker(next.text) === speaker
        ? next.text.slice(speaker.length)
        : next.text;

      merged.push({ start: cue.start, end: next.end, text: `${cue.text}\n${nextText}` });
      i++;
    } else {
      merged.push(cue);
    }
  }

  console.log(`Merged ${cues.length} cues into ${merged.length} cues`);
  await writeFile(srtPath, serializeSrt(merged));
}

async function extendSubtitles(srtPath) {
  const content = await readFile(srtPath, 'utf-8');
  const cues = parseSrt(content);

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const nextStart = i + 1 < cues.length ? cues[i + 1].start : Infinity;
    cue.end = Math.min(cue.end + ADDED_DURATION, nextStart);
  }

  await writeFile(srtPath, serializeSrt(cues));
}

const targetDir = process.argv[2];
if (!targetDir) {
  console.error('Usage: node subs.mjs <target-directory>');
  process.exit(1);
}

for (const file of (await readdir(targetDir))) {
  const {ext, name} = parse(file);
  if (['.avi', '.mkv', '.mp4'].includes(ext.toLowerCase())) {
    const filePath = join(targetDir, file);
    const srtPath = join(targetDir, `${name}.srt`);
    try {
      await access(srtPath);
      console.log(`Skipping ${filePath} - subtitles already exist`);
    } catch {
      console.log(`Processing: ${filePath}`);
      await runCommand(subsaiCommand(filePath));
      await mergeSubtitles(srtPath);
      await extendSubtitles(srtPath);
    }
  }
}
