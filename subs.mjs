import { spawn } from 'child_process';
import { readdir, access } from 'fs/promises';
import { dirname, join, parse } from 'path';
import { fileURLToPath } from 'url';

const subsaiCommand = (file) => `subsai "${file}" --format srt --translation-source-lang en --model m-bain/whisperX --model-configs "{\\"model_type\\": \\"large-v3\\", \\"device\\": \\"cuda\\", \\"batch_size\\": 4}"`

const repoDir = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';
const activate = isWindows
  ? `"${join(repoDir, 'Scripts', 'activate.bat')}"`
  : `source "${join(repoDir, '.venv', 'bin', 'activate')}"`;
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

const targetDir = process.argv[2];
if (!targetDir) {
  console.error('Usage: node subs.mjs <target-directory>');
  process.exit(1);
}

for (const file of (await readdir(targetDir))) {
  const {ext, name} = parse(file);
  if (['.avi', '.mkv', '.mp4'].includes(ext.toLowerCase())) {
    const filePath = join(targetDir, file);
    try {
      await access(join(targetDir, `${name}.srt`));
      console.log(`Skipping ${filePath} - subtitles already exist`);
    } catch {
      console.log(`Processing: ${filePath}`);
      await runCommand(subsaiCommand(filePath));
    }
  }
}
