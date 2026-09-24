import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

export type Activity = {
  at: string; kind: string; loop?: string; runId?: string; sessionKey?: string;
  tool?: string; source?: string; state?: string; text?: string; durationMs?: number;
};
export class StudioActivity {
  private readonly file: string;
  constructor(stateDir: string) { this.file = path.join(stateDir, 'activity.jsonl'); }
  record(event: Omit<Activity, 'at'>): void {
    if (existsSync(this.file) && statSync(this.file).size > 2_000_000) renameSync(this.file, `${this.file}.previous`);
    appendFileSync(this.file, JSON.stringify({ ...event, text: event.text?.slice(0, 4000), at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  }
  read(): Activity[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8').trim().split('\n').slice(-200).flatMap(line => {
      try { return [JSON.parse(line) as Activity]; } catch { return []; }
    });
  }
}
