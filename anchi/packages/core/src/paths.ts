import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Resolves a user-supplied path: `~` expands to $HOME, relative paths resolve against `base`. */
export function resolvePath(p: string, base: string): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

export function anchiHome(): string {
  return resolvePath(process.env.ANCHI_HOME ?? '~/.anchi', process.cwd());
}

export interface HomeLayout {
  root: string;
  agentsDir: string;
  templatesDir: string;
  imagesDir: string;
  dataDir: string;
  dbFile: string;
  runDir: string;
  socketFile: string;
  logFile: string;
}

export function homeLayout(root = anchiHome()): HomeLayout {
  return {
    root,
    agentsDir: join(root, 'agents'),
    templatesDir: join(root, 'templates'),
    imagesDir: join(root, 'images'),
    dataDir: join(root, 'data'),
    dbFile: join(root, 'data', 'anchi.db'),
    runDir: join(root, 'run'),
    socketFile: join(root, 'run', 'daemon.sock'),
    logFile: join(root, 'data', 'daemon.log'),
  };
}
