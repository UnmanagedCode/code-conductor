// A stand-in server for the restart supervisor's real-process tests.
//   node supervisedServer.mjs <dir> restart <extra…>
//     run 1 exits 75; run 2 records its argv, ppid and supervisor marker into
//     <dir>/run-2.json, reads stdin to its end, and exits 0.
//   node supervisedServer.mjs <dir> signal
//     prints `ready`; on SIGTERM appends one line to <dir>/signals and exits 0.
import fs from 'node:fs';
import path from 'node:path';

const [dir, mode, ...extra] = process.argv.slice(2);

if (mode === 'signal') {
  process.on('SIGTERM', () => {
    fs.appendFileSync(path.join(dir, 'signals'), 'SIGTERM\n');
    process.exit(0);
  });
  process.stdout.write('ready\n');
  setInterval(() => {}, 1000);
} else {
  const counter = path.join(dir, 'runs');
  fs.appendFileSync(counter, 'x');
  const run = fs.readFileSync(counter, 'utf8').length;
  if (run === 1) process.exit(75);
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { stdin += d; });
  process.stdin.on('end', () => {
    fs.writeFileSync(path.join(dir, `run-${run}.json`), JSON.stringify({
      argv: extra, ppid: process.ppid, marker: process.env.CC_RESTART_SUPERVISOR, cwd: process.cwd(), stdin,
    }));
    process.exit(0);
  });
}
