// Applies pending migrations to the isolated TEST_DATABASE_URL Neon branch
// (see require-destructive-test-guard.ts and .env.example) instead of the
// app's real DATABASE_URL.
//
// prisma.config.ts resolves the datasource URL from `process.env.DATABASE_URL`
// at CLI-invocation time, with no per-command override flag - so this script
// spawns `npx prisma migrate deploy` as a child process with `DATABASE_URL`
// overridden ONLY in that child's environment. The parent shell's actual
// DATABASE_URL is never touched, deliberately avoiding a "temporarily
// repoint DATABASE_URL by hand" step - the same footgun shape that caused
// this project's real data loss incidents.
import { spawn } from 'node:child_process';
import 'dotenv/config';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  console.error(
    'TEST_DATABASE_URL is not set. Create a separate Neon branch and set it in .env - see the ' +
      'TEST_DATABASE_URL comment in .env.example for how.'
  );
  process.exit(1);
}

const child = spawn('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: testDatabaseUrl },
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
