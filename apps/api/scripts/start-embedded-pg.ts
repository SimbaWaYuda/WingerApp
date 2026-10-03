import * as fs from 'fs';
import * as path from 'path';
import EmbeddedPostgres from 'embedded-postgres';

async function main() {
  const databaseDir = path.join(process.cwd(), '.pgdata');
  const port = Number(process.env.PG_PORT ?? 5433);

  if (!fs.existsSync(databaseDir)) {
    fs.mkdirSync(databaseDir, { recursive: true });
  }

  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'winger',
    password: 'winger',
    port,
    persistent: true,
  });

  const marker = path.join(databaseDir, 'PG_VERSION');
  if (!fs.existsSync(marker)) {
    // eslint-disable-next-line no-console
    console.log('Initialising embedded Postgres cluster...');
    await pg.initialise();
  }

  // eslint-disable-next-line no-console
  console.log(`Starting embedded Postgres on port ${port}...`);
  await pg.start();

  try {
    await pg.createDatabase('winger');
    // eslint-disable-next-line no-console
    console.log('Database "winger" ready');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) {
      // eslint-disable-next-line no-console
      console.log('createDatabase note:', message);
    } else {
      // eslint-disable-next-line no-console
      console.log('Database "winger" already exists');
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `DATABASE_URL=postgresql://winger:winger@localhost:${port}/winger?schema=public`,
  );
  // eslint-disable-next-line no-console
  console.log('Embedded Postgres is running. Keep this process open.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
